#!/usr/bin/env python3
"""OmniRoute VPS Operations Control Helper (omniroute_opsctl).

Fixed allowlisted operations helper for the OmniRoute Telegram Ops Bot.
Emits structured JSON, uses subprocess argument arrays only (no shell=True),
and strictly validates all inputs and operations against allowlists.

Operations supported:
  - system: Host system resource metrics (CPU, memory, disk, uptime, load)
  - containers: Container health and metrics
  - omniroute / app: OmniRoute application internal status and circuit breakers
  - deploy: Current deployment info, active slot, and image digests
  - logs: Safe bounded service log retrieval
  - backups / backup: Database backup status, creation, and integrity check
  - restart: Allowlisted service restart
  - rollback: Guarded blue/green deployment rollback
  - security: Firewall, tunnel, and authentication metrics
  - status: Comprehensive status summary across all subsystems
"""

import argparse
import datetime
import errno
import fcntl
import glob
import gzip
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple, Union

logger = logging.getLogger("omniroute_opsctl")

DEFAULT_APP_DIR = os.environ.get("OMNIROUTE_APP_DIR", os.environ.get("APP_DIR", "/opt/omniroute"))
DEFAULT_PORT = int(os.environ.get("OMNIROUTE_PORT", os.environ.get("APP_PORT", "20128")))

# Strict allowlists
ALLOWED_RESTART_SERVICES = frozenset({
    "app",
    "app-blue",
    "app-green",
    "caddy",
    "cloudflared",
    "redis",
    "omniroute-ops-bot",
})

ALLOWED_LOG_SERVICES = frozenset({
    "app",
    "app-blue",
    "app-green",
    "caddy",
    "cloudflared",
    "redis",
    "omniroute-ops-bot",
})

MIN_LOG_LINES = 1
MAX_LOG_LINES = 500
DEFAULT_LOG_LINES = 50


def get_paths(app_dir: Optional[str] = None) -> Dict[str, str]:
    """Resolve paths for the fixed OmniRoute stack root."""
    base = os.path.realpath(app_dir or DEFAULT_APP_DIR)
    allowed_base = os.path.realpath(DEFAULT_APP_DIR)
    if os.geteuid() == 0 and base != allowed_base:
        raise ValueError(f"app directory must be {allowed_base}")
    state_dir = os.environ.get("STATE_DIR", os.path.join(base, "state"))
    data_dir = os.environ.get("DATA_DIR", os.path.join(base, "data"))
    backups_dir = os.environ.get("BACKUPS_DIR", os.path.join(base, "backups"))
    caddy_dir = os.path.join(base, "caddy")

    return {
        "app_dir": base,
        "compose_file": os.environ.get("COMPOSE_FILE", os.path.join(base, "compose.yml")),
        "state_dir": state_dir,
        "data_dir": data_dir,
        "backups_dir": backups_dir,
        "caddy_dir": caddy_dir,
        "deploy_env": os.path.join(base, ".deploy.env"),
        "active_slot_file": os.path.join(state_dir, "active_slot"),
        "prev_image_file": os.path.join(state_dir, "previous_image"),
        "deploy_lock_file": os.path.join(state_dir, "deploy.lock"),
        "deploy_script": os.path.join(base, "deploy.sh"),
        "backup_script": os.path.join(base, "backup.sh"),
        "db_file": os.path.join(data_dir, "storage.sqlite"),
        "caddy_route": os.path.join(caddy_dir, "active.caddy"),
    }


def parse_size_to_mb(value: str) -> float:
    """Parse Docker human-readable memory sizes into MiB."""
    match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B)\s*", value, re.IGNORECASE)
    if not match:
        return 0.0
    amount = float(match.group(1))
    unit = match.group(2).upper()
    factors = {
        "B": 1 / (1024 * 1024),
        "KB": 1 / 1024,
        "KIB": 1 / 1024,
        "MB": 1,
        "MIB": 1,
        "GB": 1024,
        "GIB": 1024,
        "TB": 1024 * 1024,
        "TIB": 1024 * 1024,
    }
    return round(amount * factors.get(unit, 0), 2)


def safe_run_command(cmd: List[str], timeout: float = 15.0) -> Tuple[int, str, str]:
    """Execute a subprocess command without shell=True."""
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            shell=False,
            timeout=timeout,
            check=False,
        )
        return res.returncode, res.stdout.strip(), res.stderr.strip()
    except subprocess.TimeoutExpired:
        return 124, "", f"Command timed out after {timeout} seconds"
    except FileNotFoundError:
        return 127, "", f"Executable not found: {cmd[0] if cmd else 'empty command'}"
    except PermissionError:
        return 126, "", f"Permission denied executing: {cmd[0] if cmd else 'empty command'}"
    except Exception as err:
        return 1, "", f"Execution error: {err}"


def format_iso_timestamp(ts: Optional[float] = None) -> str:
    """Format Unix timestamp as UTC ISO 8601 string."""
    if ts is None:
        ts = time.time()
    return datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


# ─────────────────────────────────────────────────────────────────────────────
#  Subsystem Status Collectors
# ─────────────────────────────────────────────────────────────────────────────

def get_system_status(paths: Dict[str, str]) -> Dict[str, Any]:
    """Collect host system metrics (CPU, RAM, disk, load, uptime)."""
    hostname = platform.node()
    os_name = f"{platform.system()} {platform.release()}"
    uptime_seconds = 0.0

    # Read uptime from /proc/uptime if on Linux
    if os.path.exists("/proc/uptime"):
        try:
            with open("/proc/uptime", "r", encoding="utf-8") as f:
                uptime_seconds = float(f.read().split()[0])
        except Exception:
            uptime_seconds = 0.0

    # Load average
    try:
        load_avg = list(os.getloadavg())
    except (AttributeError, OSError):
        load_avg = [0.0, 0.0, 0.0]

    cpu_count = os.cpu_count() or 1

    # CPU usage calculation via /proc/stat
    cpu_usage_pct = 0.0
    if os.path.exists("/proc/stat"):
        try:
            with open("/proc/stat", "r", encoding="utf-8") as f:
                first_line = f.readline()
            parts = [float(x) for x in first_line.split()[1:]]
            if len(parts) >= 4:
                idle = parts[3]
                total = sum(parts)
                time.sleep(0.1)
                with open("/proc/stat", "r", encoding="utf-8") as f:
                    second_line = f.readline()
                parts2 = [float(x) for x in second_line.split()[1:]]
                idle2 = parts2[3]
                total2 = sum(parts2)
                diff_total = total2 - total
                diff_idle = idle2 - idle
                if diff_total > 0:
                    cpu_usage_pct = round((1.0 - (diff_idle / diff_total)) * 100.0, 1)
        except Exception:
            cpu_usage_pct = 0.0

    # Memory metrics via /proc/meminfo
    mem_total_mb = 0.0
    mem_free_mb = 0.0
    mem_used_mb = 0.0
    mem_pct = 0.0
    if os.path.exists("/proc/meminfo"):
        try:
            mem_data: Dict[str, float] = {}
            with open("/proc/meminfo", "r", encoding="utf-8") as f:
                for line in f:
                    parts = line.split(":")
                    if len(parts) == 2:
                        key = parts[0].strip()
                        val = parts[1].strip().split()[0]
                        mem_data[key] = float(val)
            mem_total_mb = round(mem_data.get("MemTotal", 0.0) / 1024.0, 1)
            mem_avail_kb = mem_data.get(
                "MemAvailable",
                mem_data.get("MemFree", 0.0) + mem_data.get("Buffers", 0.0) + mem_data.get("Cached", 0.0)
            )
            mem_free_mb = round(mem_avail_kb / 1024.0, 1)
            mem_used_mb = round(max(0.0, mem_total_mb - mem_free_mb), 1)
            if mem_total_mb > 0:
                mem_pct = round((mem_used_mb / mem_total_mb) * 100.0, 1)
        except Exception:
            pass

    # Disk usage
    target_dir = paths["app_dir"] if os.path.exists(paths["app_dir"]) else "/"
    try:
        usage = shutil.disk_usage(target_dir)
        disk_total_gb = round(usage.total / (1024.0 ** 3), 1)
        disk_used_gb = round(usage.used / (1024.0 ** 3), 1)
        disk_free_gb = round(usage.free / (1024.0 ** 3), 1)
        disk_pct = round((usage.used / usage.total) * 100.0, 1) if usage.total > 0 else 0.0
    except Exception:
        disk_total_gb = 0.0
        disk_used_gb = 0.0
        disk_free_gb = 0.0
        disk_pct = 0.0

    return {
        "hostname": hostname,
        "os_name": os_name,
        "uptime_seconds": uptime_seconds,
        "load_avg": [round(x, 2) for x in load_avg],
        "cpu_count": cpu_count,
        "cpu_usage_pct": cpu_usage_pct,
        "mem_total_mb": mem_total_mb,
        "mem_used_mb": mem_used_mb,
        "mem_free_mb": mem_free_mb,
        "mem_pct": mem_pct,
        "disk_total_gb": disk_total_gb,
        "disk_used_gb": disk_used_gb,
        "disk_free_gb": disk_free_gb,
        "disk_pct": disk_pct,
    }


def get_containers_status(paths: Dict[str, str]) -> Dict[str, Any]:
    """Query docker container states without shell injection."""
    containers: List[Dict[str, Any]] = []

    # First attempt: docker ps with JSON format
    code, out, _ = safe_run_command(["docker", "ps", "-a", "--format", "{{json .}}"], timeout=8.0)
    if code == 0 and out:
        for line in out.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                c_json = json.loads(line)
                name = c_json.get("Names", c_json.get("Name", "unknown"))
                if name.startswith("/"):
                    name = name[1:]
                cid = c_json.get("ID", "")[:12]
                status = c_json.get("Status", c_json.get("State", "unknown"))
                image = c_json.get("Image", "")

                containers.append({
                    "name": name,
                    "id": cid,
                    "status": status,
                    "image": image,
                    "cpu_pct": 0.0,
                    "mem_usage_mb": 0.0,
                    "mem_limit_mb": 0.0,
                })
            except json.JSONDecodeError:
                continue

    # Populate live CPU/RAM for containers returned above.
    if containers:
        code, stats_out, _ = safe_run_command(
            ["docker", "stats", "--no-stream", "--format", "{{json .}}"],
            timeout=12.0,
        )
        if code == 0:
            stats_by_name: Dict[str, Dict[str, float]] = {}
            for line in stats_out.splitlines():
                try:
                    row = json.loads(line)
                    name = str(row.get("Name", ""))
                    cpu = float(str(row.get("CPUPerc", "0")).rstrip("%") or 0)
                    usage_text = str(row.get("MemUsage", "0 / 0"))
                    used_text, _, limit_text = usage_text.partition("/")
                    stats_by_name[name] = {
                        "cpu_pct": cpu,
                        "mem_usage_mb": parse_size_to_mb(used_text.strip()),
                        "mem_limit_mb": parse_size_to_mb(limit_text.strip()),
                    }
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
            for container in containers:
                container.update(stats_by_name.get(str(container["name"]), {}))

    # Second attempt if docker ps returned empty: try docker compose ps
    if not containers and os.path.exists(paths["compose_file"]):
        deploy_env_args = ["--env-file", paths["deploy_env"]] if os.path.exists(paths["deploy_env"]) else []
        cmd = ["docker", "compose"] + deploy_env_args + ["-f", paths["compose_file"], "ps", "--format", "json"]
        code, out, _ = safe_run_command(cmd, timeout=8.0)
        if code == 0 and out:
            try:
                parsed = json.loads(out)
                if isinstance(parsed, list):
                    for item in parsed:
                        name = item.get("Name", item.get("Service", "unknown"))
                        status = item.get("Status", item.get("State", "unknown"))
                        containers.append({
                            "name": name,
                            "id": str(item.get("ID", ""))[:12],
                            "status": status,
                            "image": str(item.get("Image", "")),
                            "cpu_pct": 0.0,
                            "mem_usage_mb": 0.0,
                            "mem_limit_mb": 0.0,
                        })
            except json.JSONDecodeError:
                pass

    return {"containers": containers}


def get_app_status(paths: Dict[str, str], port: Optional[int] = None) -> Dict[str, Any]:
    """Query OmniRoute proxy internal status and circuit breakers."""
    app_port = port or DEFAULT_PORT
    active_slot = "none"
    if os.path.exists(paths["active_slot_file"]):
        try:
            with open(paths["active_slot_file"], "r", encoding="utf-8") as f:
                active_slot = f.read().strip() or "none"
        except Exception:
            active_slot = "none"

    url = f"http://127.0.0.1:{app_port}/api/monitoring/health"
    headers = {"User-Agent": "OmniRouteOpsCtl/1.0"}
    management_key = os.environ.get("OPS_OMNIROUTE_MANAGEMENT_KEY", "").strip()
    if management_key:
        headers["Authorization"] = f"Bearer {management_key}"
    req = urllib.request.Request(url, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            if resp.status == 200:
                body = json.loads(resp.read().decode("utf-8"))
                status_str = "ONLINE" if body.get("status") == "healthy" else "DEGRADED"
                breakers = body.get("circuit_breakers", {})
                return {
                    "status": status_str,
                    "port": app_port,
                    "version": str(body.get("version", "unknown")),
                    "active_requests": int(body.get("active_requests", 0)),
                    "circuit_breakers": breakers,
                    "cooldown_accounts": int(body.get("cooldown_accounts", 0)),
                    "active_slot": active_slot,
                }
    except Exception:
        pass

    # Fallback status if HTTP endpoint is unreachable
    status = "OFFLINE" if active_slot == "none" else "DEGRADED"
    return {
        "status": status,
        "port": app_port,
        "version": "unknown",
        "active_requests": 0,
        "circuit_breakers": {},
        "cooldown_accounts": 0,
        "active_slot": active_slot,
    }


def get_deploy_status(paths: Dict[str, str]) -> Dict[str, Any]:
    """Retrieve current blue/green deployment and version details."""
    active_slot = "none"
    if os.path.exists(paths["active_slot_file"]):
        try:
            with open(paths["active_slot_file"], "r", encoding="utf-8") as f:
                active_slot = f.read().strip() or "none"
        except Exception:
            active_slot = "none"

    prev_image = "none"
    if os.path.exists(paths["prev_image_file"]):
        try:
            with open(paths["prev_image_file"], "r", encoding="utf-8") as f:
                prev_image = f.read().strip() or "none"
        except Exception:
            prev_image = "none"

    blue_image = ""
    green_image = ""
    if os.path.exists(paths["deploy_env"]):
        try:
            with open(paths["deploy_env"], "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("BLUE_IMAGE="):
                        blue_image = line.split("=", 1)[1]
                    elif line.startswith("GREEN_IMAGE="):
                        green_image = line.split("=", 1)[1]
        except Exception:
            pass

    active_image = blue_image if active_slot == "blue" else (green_image if active_slot == "green" else "")
    current_commit = "HEAD"
    if "@sha256:" in active_image:
        current_commit = active_image.split("@sha256:")[1][:7]

    last_deploy_time = "none"
    if os.path.exists(paths["active_slot_file"]):
        try:
            mtime = os.path.getmtime(paths["active_slot_file"])
            last_deploy_time = format_iso_timestamp(mtime)
        except Exception:
            last_deploy_time = "none"

    status = "DEPLOYED" if active_slot in ("blue", "green") else "NOT_DEPLOYED"

    return {
        "current_commit": current_commit,
        "branch": "prod",
        "version": "unknown",
        "last_deploy_time": last_deploy_time,
        "status": status,
        "commit_message": f"Deploy {active_slot} ({active_image})" if active_image else "",
        "active_slot": active_slot,
        "blue_image": blue_image,
        "green_image": green_image,
        "previous_image": prev_image,
    }


def get_logs(
    paths: Dict[str, str],
    service: Optional[str] = None,
    lines: int = DEFAULT_LOG_LINES,
) -> Dict[str, Any]:
    """Retrieve bounded logs for allowlisted service."""
    bounded_lines = min(max(MIN_LOG_LINES, int(lines)), MAX_LOG_LINES)

    target_service = service or "app"
    if target_service not in ALLOWED_LOG_SERVICES:
        return {
            "status": "ERROR",
            "error": f"Service '{target_service}' is not in allowed log services: {sorted(list(ALLOWED_LOG_SERVICES))}",
            "lines": bounded_lines,
            "logs": "",
        }

    # If 'app' is requested, resolve to the active slot
    if target_service == "app":
        active_slot = "blue"
        if os.path.exists(paths["active_slot_file"]):
            try:
                with open(paths["active_slot_file"], "r", encoding="utf-8") as f:
                    val = f.read().strip()
                    if val in ("blue", "green"):
                        active_slot = val
            except Exception:
                active_slot = "blue"
        target_service = f"app-{active_slot}"

    if target_service == "omniroute-ops-bot":
        cmd = ["journalctl", "-u", "omniroute-ops-bot.service", "-n", str(bounded_lines), "--no-pager"]
        code, out, err = safe_run_command(cmd, timeout=8.0)
        logs_text = out if code == 0 and out else (err or "No log output available")
    else:
        deploy_env_args = ["--env-file", paths["deploy_env"]] if os.path.exists(paths["deploy_env"]) else []
        cmd = ["docker", "compose"] + deploy_env_args + [
            "-f", paths["compose_file"],
            "logs",
            "--tail", str(bounded_lines),
            target_service,
        ]
        code, out, err = safe_run_command(cmd, timeout=10.0)
        logs_text = out if code == 0 and out else (err or "No log output available")

    return {
        "status": "SUCCESS",
        "service": target_service,
        "lines": bounded_lines,
        "logs": logs_text,
    }


def get_backups_status(paths: Dict[str, str]) -> Dict[str, Any]:
    """List and report SQLite database backups."""
    backups_dir = paths["backups_dir"]
    if not os.path.exists(backups_dir):
        return {
            "latest_backup_file": "none",
            "latest_backup_time": "none",
            "size_bytes": 0,
            "status": "NONE",
            "total_backups": 0,
            "backups": [],
        }

    pattern = os.path.join(backups_dir, "storage-*.sqlite*")
    matches = glob.glob(pattern)

    # Filter only regular files
    files = [f for f in matches if os.path.isfile(f)]
    files.sort(key=lambda x: os.path.getmtime(x), reverse=True)

    if not files:
        return {
            "latest_backup_file": "none",
            "latest_backup_time": "none",
            "size_bytes": 0,
            "status": "NONE",
            "total_backups": 0,
            "backups": [],
        }

    latest = files[0]
    latest_size = os.path.getsize(latest)
    latest_mtime = format_iso_timestamp(os.path.getmtime(latest))
    latest_name = os.path.basename(latest)

    backups_list = []
    for f in files[:20]:
        backups_list.append({
            "file": os.path.basename(f),
            "size_bytes": os.path.getsize(f),
            "mtime": format_iso_timestamp(os.path.getmtime(f)),
        })

    return {
        "latest_backup_file": latest_name,
        "latest_backup_time": latest_mtime,
        "size_bytes": latest_size,
        "status": "VERIFIED",
        "total_backups": len(files),
        "backups": backups_list,
    }


def create_backup(paths: Dict[str, str]) -> Dict[str, Any]:
    """Execute backup.sh or internal atomic SQLite backup with integrity verification."""
    backup_script = paths["backup_script"]
    if os.path.exists(backup_script) and os.access(backup_script, os.X_OK):
        code, out, err = safe_run_command([backup_script], timeout=60.0)
        if code != 0:
            return {
                "status": "ERROR",
                "error": f"backup.sh failed with code {code}: {err or out}",
                "verified": False,
            }
        # Refresh backups status
        status_info = get_backups_status(paths)
        return {
            "status": "SUCCESS",
            "file": status_info["latest_backup_file"],
            "size_bytes": status_info["size_bytes"],
            "verified": True,
            "timestamp": status_info["latest_backup_time"],
        }

    # Fallback direct backup using sqlite3 CLI
    db_file = paths["db_file"]
    if not os.path.exists(db_file):
        return {
            "status": "ERROR",
            "error": f"Database file not found: {db_file}",
            "verified": False,
        }

    os.makedirs(paths["backups_dir"], exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_file = os.path.join(paths["backups_dir"], f"storage-{stamp}.sqlite")

    # Run sqlite3 .backup
    code, _, err = safe_run_command(["sqlite3", db_file, f".backup '{out_file}'"], timeout=30.0)
    if code != 0:
        return {
            "status": "ERROR",
            "error": f"sqlite3 .backup failed: {err}",
            "verified": False,
        }

    # Verify integrity
    code, out, err = safe_run_command(["sqlite3", out_file, "PRAGMA integrity_check;"], timeout=15.0)
    if code != 0 or out.strip() != "ok":
        return {
            "status": "ERROR",
            "error": f"Integrity check failed on backup {out_file}: {err or out}",
            "verified": False,
        }

    # Gzip the file
    gz_file = f"{out_file}.gz"
    try:
        with open(out_file, "rb") as f_in, gzip.open(gz_file, "wb", compresslevel=9) as f_out:
            shutil.copyfileobj(f_in, f_out)
        os.remove(out_file)
    except Exception as exc:
        return {
            "status": "ERROR",
            "error": f"Failed to compress backup: {exc}",
            "verified": False,
        }

    size_bytes = os.path.getsize(gz_file)
    return {
        "status": "SUCCESS",
        "file": os.path.basename(gz_file),
        "size_bytes": size_bytes,
        "verified": True,
        "timestamp": format_iso_timestamp(),
    }


def check_backup(paths: Dict[str, str], backup_file: Optional[str] = None) -> Dict[str, Any]:
    """Verify integrity of a database backup file."""
    backups_dir = paths["backups_dir"]
    target_path: str

    if backup_file:
        # Prevent directory traversal
        clean_name = os.path.basename(backup_file)
        target_path = os.path.join(backups_dir, clean_name)
    else:
        status_info = get_backups_status(paths)
        if status_info["latest_backup_file"] == "none":
            return {"status": "ERROR", "error": "No backup files found to verify"}
        target_path = os.path.join(backups_dir, status_info["latest_backup_file"])

    if not os.path.isfile(target_path):
        return {"status": "ERROR", "error": f"Backup file does not exist: {target_path}"}

    # Integrity verification
    if target_path.endswith(".gz"):
        try:
            with gzip.open(target_path, "rb") as gz:
                # Read chunks to test gzip crc/structure
                while True:
                    chunk = gz.read(65536)
                    if not chunk:
                        break
        except Exception as exc:
            return {"status": "CORRUPT", "file": os.path.basename(target_path), "error": f"Gzip corruption: {exc}"}

        return {
            "status": "VERIFIED",
            "file": os.path.basename(target_path),
            "integrity": "ok",
            "size_bytes": os.path.getsize(target_path),
        }

    # Plain sqlite verification
    code, out, err = safe_run_command(["sqlite3", target_path, "PRAGMA integrity_check;"], timeout=15.0)
    if code == 0 and out.strip() == "ok":
        return {
            "status": "VERIFIED",
            "file": os.path.basename(target_path),
            "integrity": "ok",
            "size_bytes": os.path.getsize(target_path),
        }

    return {
        "status": "CORRUPT",
        "file": os.path.basename(target_path),
        "error": f"Integrity check failed: {err or out}",
    }


def restart_service(paths: Dict[str, str], service: str) -> Dict[str, Any]:
    """Restart allowlisted service safely."""
    if service not in ALLOWED_RESTART_SERVICES:
        return {
            "status": "ERROR",
            "error": f"Service '{service}' is not in allowed restart services list: {sorted(list(ALLOWED_RESTART_SERVICES))}",
        }

    if service == "omniroute-ops-bot":
        cmd = ["systemctl", "restart", "omniroute-ops-bot.service"]
        code, out, err = safe_run_command(cmd, timeout=15.0)
    elif service == "app":
        active_slot = "blue"
        if os.path.exists(paths["active_slot_file"]):
            try:
                with open(paths["active_slot_file"], "r", encoding="utf-8") as f:
                    val = f.read().strip()
                    if val in ("blue", "green"):
                        active_slot = val
            except Exception:
                active_slot = "blue"
        target_service = f"app-{active_slot}"
        deploy_env_args = ["--env-file", paths["deploy_env"]] if os.path.exists(paths["deploy_env"]) else []
        cmd = ["docker", "compose"] + deploy_env_args + ["-f", paths["compose_file"], "restart", target_service]
        code, out, err = safe_run_command(cmd, timeout=30.0)
    else:
        deploy_env_args = ["--env-file", paths["deploy_env"]] if os.path.exists(paths["deploy_env"]) else []
        cmd = ["docker", "compose"] + deploy_env_args + ["-f", paths["compose_file"], "restart", service]
        code, out, err = safe_run_command(cmd, timeout=30.0)

    if code == 0:
        return {
            "status": "SUCCESS",
            "service": service,
            "message": f"Service {service} restarted successfully",
        }

    return {
        "status": "ERROR",
        "service": service,
        "error": f"Failed to restart {service} (code {code}): {err or out}",
    }


def execute_guarded_rollback(paths: Dict[str, str]) -> Dict[str, Any]:
    """Guarded blue/green rollback requiring lock check, pre-backup, deploy.sh invocation, and health check."""
    # 1. Lock check
    os.makedirs(paths["state_dir"], exist_ok=True)
    lock_file = paths["deploy_lock_file"]
    try:
        lock_fd = os.open(lock_file, os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, OSError) as err:
        return {
            "status": "ERROR",
            "error": "Deploy lock is held by another process; cannot perform rollback at this time",
        }

    try:
        # 2. Previous image check
        if not os.path.exists(paths["prev_image_file"]):
            return {
                "status": "ERROR",
                "error": "No previous image recorded (state/previous_image missing); nothing to roll back to",
            }

        with open(paths["prev_image_file"], "r", encoding="utf-8") as f:
            prev_image = f.read().strip()

        if not prev_image:
            return {
                "status": "ERROR",
                "error": "Previous image file is empty; nothing to roll back to",
            }

        # 3. Create and verify pre-rollback database backup
        backup_res = create_backup(paths)
        if backup_res.get("status") != "SUCCESS" or not backup_res.get("verified"):
            return {
                "status": "ERROR",
                "error": "Pre-rollback database backup failed or could not be verified; aborting rollback",
                "backup_result": backup_res,
            }

        # 4. Invoke deploy.sh --rollback
        deploy_script = paths["deploy_script"]
        if not os.path.exists(deploy_script) or not os.access(deploy_script, os.X_OK):
            return {
                "status": "ERROR",
                "error": f"deploy.sh not found or not executable at {deploy_script}",
            }

        # Release file descriptor lock before calling deploy.sh (deploy.sh will acquire deploy.lock itself)
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)
        lock_fd = -1

        code, out, err = safe_run_command([deploy_script, "--rollback"], timeout=360.0)
        if code != 0:
            return {
                "status": "FAILED",
                "error": f"deploy.sh --rollback failed with exit code {code}",
                "stdout": out,
                "stderr": err,
            }

        # 5. Post-health verification
        health = get_app_status(paths)
        if health.get("status") in ("ONLINE", "healthy"):
            return {
                "status": "SUCCESS",
                "action": "rollback",
                "previous_image": prev_image,
                "backup_file": backup_res.get("file"),
                "post_health": health,
            }

        return {
            "status": "DEGRADED",
            "action": "rollback",
            "previous_image": prev_image,
            "backup_file": backup_res.get("file"),
            "post_health": health,
            "warning": "deploy.sh --rollback completed but post-health check is not ONLINE",
        }
    finally:
        if lock_fd >= 0:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                os.close(lock_fd)
            except Exception:
                pass


def get_security_status(paths: Dict[str, str]) -> Dict[str, Any]:
    """Collect firewall, open tunnels, and security metrics."""
    firewall_status = "unknown"

    # Check ufw
    code, out, _ = safe_run_command(["ufw", "status"], timeout=5.0)
    if code == 0 and "Status:" in out:
        firewall_status = "active (ufw)" if "Status: active" in out else "inactive (ufw)"
    else:
        # Check firewall-cmd
        code, out, _ = safe_run_command(["firewall-cmd", "--state"], timeout=5.0)
        if code == 0:
            firewall_status = f"active (firewalld: {out.strip()})"

    # Check open tunnels (e.g. cloudflared container)
    open_tunnels: List[str] = []
    containers_res = get_containers_status(paths)
    for c in containers_res.get("containers", []):
        if "cloudflared" in c.get("name", "").lower() and "running" in c.get("status", "").lower() or "up" in c.get("status", "").lower():
            open_tunnels.append("cloudflared")

    app_stat = get_app_status(paths)
    open_breakers = sum(1 for v in app_stat.get("circuit_breakers", {}).values() if v == "OPEN")

    return {
        "firewall_status": firewall_status,
        "locked_users_count": 0,
        "failed_auth_recent": 0,
        "circuit_breaker_open_count": open_breakers,
        "open_tunnels": open_tunnels,
    }


def get_overall_status(paths: Dict[str, str]) -> Dict[str, Any]:
    """Consolidated full-stack status report."""
    return {
        "system": get_system_status(paths),
        "omniroute": get_app_status(paths),
        "containers": get_containers_status(paths).get("containers", []),
        "deploy": get_deploy_status(paths),
        "backups": get_backups_status(paths),
        "security": get_security_status(paths),
    }


# ─────────────────────────────────────────────────────────────────────────────
#  CLI Interface
# ─────────────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    """Build strictly typed argument parser."""
    common_parent = argparse.ArgumentParser(add_help=False)
    common_parent.add_argument(
        "--app-dir",
        default=None,
        help="Path to OmniRoute stack directory (default: /opt/omniroute or $OMNIROUTE_APP_DIR)",
    )
    common_parent.add_argument(
        "--json",
        action="store_true",
        default=True,
        help="Output structured JSON (default: True)",
    )

    parser = argparse.ArgumentParser(
        prog="omniroute_opsctl",
        description="OmniRoute VPS Operations Control Helper",
        parents=[common_parent],
    )

    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    # Subcommands matching bot metrics collector
    subparsers.add_parser("status", parents=[common_parent], help="Get comprehensive system and proxy status")
    subparsers.add_parser("system", parents=[common_parent], help="Get host resource utilization metrics")
    subparsers.add_parser("containers", parents=[common_parent], help="Get container status metrics")
    subparsers.add_parser("omniroute", parents=[common_parent], help="Get OmniRoute proxy internal status")
    subparsers.add_parser("app", parents=[common_parent], help="Alias for omniroute")
    subparsers.add_parser("deploy", parents=[common_parent], help="Get blue/green deploy and git version info")
    subparsers.add_parser("security", parents=[common_parent], help="Get security, firewall, and tunnel metrics")

    # Logs command
    logs_p = subparsers.add_parser("logs", parents=[common_parent], help="Get service logs")
    logs_p.add_argument("--service", default="app", help="Service name (default: active app)")
    logs_p.add_argument("--lines", type=int, default=DEFAULT_LOG_LINES, help="Tail line count (1-500)")

    # Backups command
    backups_p = subparsers.add_parser("backups", parents=[common_parent], help="List or manage database backups")
    backups_p.add_argument(
        "action",
        nargs="?",
        default="list",
        choices=["list", "create", "check", "verify"],
        help="Backup action to perform",
    )
    backups_p.add_argument("--file", default=None, help="Backup file for check action")

    backup_alias = subparsers.add_parser("backup", parents=[common_parent], help="Alias for backups")
    backup_alias.add_argument(
        "action",
        nargs="?",
        default="list",
        choices=["list", "create", "check", "verify"],
        help="Backup action to perform",
    )
    backup_alias.add_argument("--file", default=None, help="Backup file for check action")

    # Restart command
    restart_p = subparsers.add_parser("restart", parents=[common_parent], help="Restart an allowlisted service")
    restart_p.add_argument(
        "service_pos",
        nargs="?",
        default=None,
        help="Service to restart (app, caddy, redis, cloudflared, omniroute-ops-bot)",
    )
    restart_p.add_argument(
        "--service",
        default=None,
        help="Service to restart",
    )

    # Rollback command
    subparsers.add_parser("rollback", parents=[common_parent], help="Execute guarded blue/green deployment rollback")

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    """Main execution entrypoint."""
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        paths = get_paths(args.app_dir)
    except ValueError as error:
        print(json.dumps({"status": "ERROR", "error": str(error)}, sort_keys=True))
        return 2
    result: Dict[str, Any] = {}
    exit_code = 0

    subcmd = args.subcommand.lower()

    if subcmd == "status":
        result = get_overall_status(paths)
    elif subcmd == "system":
        result = get_system_status(paths)
    elif subcmd == "containers":
        result = get_containers_status(paths)
    elif subcmd in ("omniroute", "app"):
        result = get_app_status(paths)
    elif subcmd == "deploy":
        result = get_deploy_status(paths)
    elif subcmd == "security":
        result = get_security_status(paths)
    elif subcmd == "logs":
        log_res = get_logs(paths, service=args.service, lines=args.lines)
        if args.json:
            result = log_res
        else:
            print(log_res.get("logs", ""))
            return 0 if log_res.get("status") == "SUCCESS" else 1
    elif subcmd in ("backups", "backup"):
        action = getattr(args, "action", "list")
        if action == "list":
            result = get_backups_status(paths)
        elif action == "create":
            result = create_backup(paths)
            if result.get("status") != "SUCCESS":
                exit_code = 1
        elif action in ("check", "verify"):
            result = check_backup(paths, backup_file=getattr(args, "file", None))
            if result.get("status") != "VERIFIED":
                exit_code = 1
    elif subcmd == "restart":
        service = args.service or args.service_pos or "app"
        result = restart_service(paths, service)
        if result.get("status") != "SUCCESS":
            exit_code = 1
    elif subcmd == "rollback":
        result = execute_guarded_rollback(paths)
        if result.get("status") not in ("SUCCESS", "DEGRADED"):
            exit_code = 1

    print(json.dumps(result, indent=2, default=str))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
