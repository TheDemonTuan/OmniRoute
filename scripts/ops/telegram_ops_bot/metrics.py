"""Host and container metrics reader module.

Safely collects metrics using fixed opsctl JSON commands or stdlib /proc fallback.
Never uses shell=True or arbitrary shell execution.
Includes injectable GitHub client protocol with graceful 'not configured' fallback.
"""

import json
import logging
import os
import platform
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol, Tuple, runtime_checkable

from .security import redact_sensitive


logger = logging.getLogger("telegram_ops_bot.metrics")


def normalize_service_name(name: Optional[str]) -> str:
    """Map common container names and aliases to allowed opsctl service names."""
    if not name:
        return "app"
    raw = str(name).strip().lower()
    if raw.startswith("/"):
        raw = raw[1:]

    aliases = {
        "app": "app",
        "omniroute": "app",
        "omniroute-app": "app",
        "omniroute-app-green": "app-green",
        "omniroute-app-green-1": "app-green",
        "app-green": "app-green",
        "green": "app-green",
        "omniroute-app-blue": "app-blue",
        "omniroute-app-blue-1": "app-blue",
        "app-blue": "app-blue",
        "blue": "app-blue",
        "caddy": "caddy",
        "omniroute-caddy": "caddy",
        "omniroute-caddy-1": "caddy",
        "cloudflared": "cloudflared",
        "omniroute-cloudflared": "cloudflared",
        "omniroute-cloudflared-1": "cloudflared",
        "tunnel": "cloudflared",
        "redis": "redis",
        "omniroute-redis": "redis",
        "omniroute-redis-1": "redis",
        "bot": "omniroute-ops-bot",
        "ops-bot": "omniroute-ops-bot",
        "omniroute-ops-bot": "omniroute-ops-bot",
        "telegram": "omniroute-ops-bot",
        "portfolio": "portfolio",
        "tuan-portfolio": "portfolio",
        "tuan-portfolio-tunnel": "tuan-portfolio-tunnel",
        "portfolio-tunnel": "tuan-portfolio-tunnel",
    }
    return aliases.get(raw, raw)


@dataclass(frozen=True)
class HostMetrics:
    """Host machine resource utilization metrics."""

    hostname: str
    os_name: str
    uptime_seconds: float
    load_avg: Tuple[float, float, float]
    cpu_count: int
    cpu_usage_pct: float
    mem_total_mb: float
    mem_used_mb: float
    mem_free_mb: float
    mem_pct: float
    disk_total_gb: float
    disk_used_gb: float
    disk_free_gb: float
    disk_pct: float


@dataclass(frozen=True)
class ContainerInfo:
    """Container status representation."""

    name: str
    id: str
    status: str
    image: str
    cpu_pct: float = 0.0
    mem_usage_mb: float = 0.0
    mem_limit_mb: float = 0.0


@dataclass(frozen=True)
class OmniRouteInfo:
    """OmniRoute proxy status representation."""

    status: str
    port: int = 20128
    version: str = "unknown"
    active_requests: int = 0
    circuit_breakers: Dict[str, str] = field(default_factory=dict)
    cooldown_accounts: int = 0


@dataclass(frozen=True)
class DeployInfo:
    """Application deployment and git version info."""

    current_commit: str
    branch: str
    version: str
    last_deploy_time: str
    status: str
    commit_message: str = ""


@dataclass(frozen=True)
class BackupInfo:
    """Backup status information."""

    latest_backup_file: str
    latest_backup_time: str
    size_bytes: int
    status: str
    total_backups: int


@dataclass(frozen=True)
class SecurityMetrics:
    """Security status summary."""

    firewall_status: str
    locked_users_count: int
    failed_auth_recent: int
    circuit_breaker_open_count: int
    open_tunnels: List[str] = field(default_factory=list)


@runtime_checkable
class GitHubClientProtocol(Protocol):
    """Protocol for injectable GitHub integration."""

    def is_configured(self) -> bool: ...
    def get_latest_release(self) -> Optional[Dict[str, Any]]: ...
    def get_recent_commits(self, limit: int = 5) -> List[Dict[str, Any]]: ...


class GitHubClient:
    """Standard library GitHub API client with graceful fallback."""

    BASE_URL = "https://api.github.com"

    def __init__(self, token: Optional[str] = None, repo: Optional[str] = None) -> None:
        self.token = token.strip() if token else None
        self.repo = repo.strip() if repo else None

    def is_configured(self) -> bool:
        return bool(self.token and self.repo)

    def _api_get(self, path: str) -> Optional[Any]:
        if not self.is_configured():
            return None
        url = f"{self.BASE_URL}/repos/{self.repo}/{path}"
        headers = {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "OmniRoute-TelegramOpsBot/1.0",
        }
        if self.token:
            headers["Authorization"] = f"token {self.token}"

        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10.0) as resp:
                data = resp.read().decode("utf-8")
                return json.loads(data)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            logger.debug("GitHub API request failed for %s: %s", path, err)
            return None

    def get_latest_release(self) -> Optional[Dict[str, Any]]:
        """Fetch latest GitHub release tag and description."""
        res = self._api_get("releases/latest")
        if isinstance(res, dict):
            return {
                "tag_name": res.get("tag_name", "unknown"),
                "name": res.get("name", ""),
                "published_at": res.get("published_at", ""),
                "html_url": res.get("html_url", ""),
            }
        return None

    def get_recent_commits(self, limit: int = 5) -> List[Dict[str, Any]]:
        """Fetch recent repository commits."""
        res = self._api_get(f"commits?per_page={limit}")
        commits: List[Dict[str, Any]] = []
        if isinstance(res, list):
            for item in res:
                if isinstance(item, dict):
                    c = item.get("commit", {})
                    author = c.get("author", {})
                    commits.append({
                        "sha": item.get("sha", "")[:7],
                        "message": c.get("message", "").split("\n")[0],
                        "author": author.get("name", "unknown"),
                        "date": author.get("date", ""),
                    })
        return commits


class MetricsCollector:
    """Collector for system, container, and application metrics."""

    def __init__(
        self,
        opsctl_path: str = "opsctl",
        github_client: Optional[GitHubClientProtocol] = None,
    ) -> None:
        self.opsctl_path = opsctl_path
        self.github_client = github_client or GitHubClient()

    def _run_opsctl_args(
        self,
        args: List[str],
        timeout: float = 12.0,
    ) -> Optional[Dict[str, Any]]:
        """Run one prevalidated opsctl argument array and parse its JSON output."""
        if not self.opsctl_path:
            return None
        cmd = [self.opsctl_path, *args, "--json"]
        if os.geteuid() != 0:
            cmd = ["sudo", "-n", *cmd]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                shell=False,
                timeout=timeout,
                check=False,
            )
            if result.stdout.strip():
                payload = json.loads(result.stdout)
                if result.returncode == 0:
                    return payload
                if isinstance(payload, dict):
                    return payload
        except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired, json.JSONDecodeError, OSError) as err:
            logger.debug("opsctl execution failed (%s): %s", args[0] if args else "unknown", err)
        return None

    def _run_opsctl_json(self, subcommand: str) -> Optional[Dict[str, Any]]:
        """Run a fixed read-only opsctl subcommand without shell."""
        allowed_subcommands = {
            "status",
            "system",
            "containers",
            "omniroute",
            "deploy",
            "logs",
            "backups",
            "security",
        }
        if subcommand not in allowed_subcommands:
            return None
        return self._run_opsctl_args([subcommand])

    def perform_operation(self, operation: str, target: str = "") -> Dict[str, Any]:
        """Run one fixed host operation through the privileged helper."""
        operation_args = {
            "backup": (["backups", "create"], 120.0),
            "rollback": (["rollback"], 420.0),
        }
        if operation == "restart":
            allowed_services = {
                "app",
                "app-blue",
                "app-green",
                "caddy",
                "cloudflared",
                "redis",
            }
            if target not in allowed_services:
                return {"status": "ERROR", "error": "Restart target is not allowed."}
            args, timeout = ["restart", "--service", target], 60.0
        elif operation in operation_args:
            args, timeout = operation_args[operation]
        else:
            return {"status": "ERROR", "error": "Operation is not allowed."}

        result = self._run_opsctl_args(args, timeout=timeout)
        return result or {"status": "ERROR", "error": "Operations helper unavailable."}

    def get_host_metrics(self) -> HostMetrics:
        """Collect host system metrics with /proc and statvfs fallback."""
        ops_data = self._run_opsctl_json("system")
        if ops_data and isinstance(ops_data, dict):
            try:
                return HostMetrics(
                    hostname=ops_data.get("hostname", platform.node()),
                    os_name=ops_data.get("os_name", f"{platform.system()} {platform.release()}"),
                    uptime_seconds=float(ops_data.get("uptime_seconds", 0.0)),
                    load_avg=tuple(ops_data.get("load_avg", [0.0, 0.0, 0.0]))[:3],
                    cpu_count=int(ops_data.get("cpu_count", os.cpu_count() or 1)),
                    cpu_usage_pct=float(ops_data.get("cpu_usage_pct", 0.0)),
                    mem_total_mb=float(ops_data.get("mem_total_mb", 0.0)),
                    mem_used_mb=float(ops_data.get("mem_used_mb", 0.0)),
                    mem_free_mb=float(ops_data.get("mem_free_mb", 0.0)),
                    mem_pct=float(ops_data.get("mem_pct", 0.0)),
                    disk_total_gb=float(ops_data.get("disk_total_gb", 0.0)),
                    disk_used_gb=float(ops_data.get("disk_used_gb", 0.0)),
                    disk_free_gb=float(ops_data.get("disk_free_gb", 0.0)),
                    disk_pct=float(ops_data.get("disk_pct", 0.0)),
                )
            except Exception:
                pass

        # Fallback stdlib + /proc
        hostname = platform.node()
        os_name = f"{platform.system()} {platform.release()}"
        cpu_count = os.cpu_count() or 1
        uptime_seconds = 0.0
        load_avg = (0.0, 0.0, 0.0)

        try:
            load_avg = os.getloadavg()
        except (AttributeError, OSError):
            pass

        # Uptime from /proc/uptime if on Linux
        if os.path.exists("/proc/uptime"):
            try:
                with open("/proc/uptime", "r", encoding="utf-8") as f:
                    uptime_seconds = float(f.readline().split()[0])
            except Exception:
                pass

        # Memory from /proc/meminfo
        mem_total_mb = 0.0
        mem_free_mb = 0.0
        mem_used_mb = 0.0
        mem_pct = 0.0
        if os.path.exists("/proc/meminfo"):
            try:
                meminfo: Dict[str, float] = {}
                with open("/proc/meminfo", "r", encoding="utf-8") as f:
                    for line in f:
                        parts = line.split(":")
                        if len(parts) == 2:
                            k = parts[0].strip()
                            v = parts[1].strip().split()[0]
                            meminfo[k] = float(v)
                total_kb = meminfo.get("MemTotal", 0.0)
                avail_kb = meminfo.get("MemAvailable", meminfo.get("MemFree", 0.0))
                used_kb = total_kb - avail_kb
                mem_total_mb = round(total_kb / 1024.0, 1)
                mem_used_mb = round(used_kb / 1024.0, 1)
                mem_free_mb = round(avail_kb / 1024.0, 1)
                if mem_total_mb > 0:
                    mem_pct = round((mem_used_mb / mem_total_mb) * 100.0, 1)
            except Exception:
                pass

        # Disk from os.statvfs
        disk_total_gb = 0.0
        disk_used_gb = 0.0
        disk_free_gb = 0.0
        disk_pct = 0.0
        try:
            stat = os.statvfs("/")
            total_b = stat.f_blocks * stat.f_frsize
            free_b = stat.f_bavail * stat.f_frsize
            used_b = total_b - (stat.f_bfree * stat.f_frsize)
            disk_total_gb = round(total_b / (1024.0**3), 2)
            disk_used_gb = round(used_b / (1024.0**3), 2)
            disk_free_gb = round(free_b / (1024.0**3), 2)
            if disk_total_gb > 0:
                disk_pct = round((disk_used_gb / disk_total_gb) * 100.0, 1)
        except Exception:
            pass

        # Approximate cpu_usage_pct from load_avg and cpu_count
        cpu_usage_pct = min(100.0, round((load_avg[0] / max(1, cpu_count)) * 100.0, 1))

        return HostMetrics(
            hostname=hostname,
            os_name=os_name,
            uptime_seconds=uptime_seconds,
            load_avg=load_avg,
            cpu_count=cpu_count,
            cpu_usage_pct=cpu_usage_pct,
            mem_total_mb=mem_total_mb,
            mem_used_mb=mem_used_mb,
            mem_free_mb=mem_free_mb,
            mem_pct=mem_pct,
            disk_total_gb=disk_total_gb,
            disk_used_gb=disk_used_gb,
            disk_free_gb=disk_free_gb,
            disk_pct=disk_pct,
        )

    def get_containers(self) -> List[ContainerInfo]:
        """Fetch container metrics via opsctl or return default state."""
        ops_data = self._run_opsctl_args(["containers"], timeout=15.0)
        if ops_data and isinstance(ops_data, dict):
            containers_list = ops_data.get("containers", [])
            results: List[ContainerInfo] = []
            for c in containers_list:
                results.append(
                    ContainerInfo(
                        name=str(c.get("name", "unknown")),
                        id=str(c.get("id", ""))[:12],
                        status=str(c.get("status", "running")),
                        image=str(c.get("image", "")),
                        cpu_pct=float(c.get("cpu_pct", 0.0)),
                        mem_usage_mb=float(c.get("mem_usage_mb", 0.0)),
                        mem_limit_mb=float(c.get("mem_limit_mb", 0.0)),
                    )
                )
            return results

        # Fallback container list
        return []

    def get_omniroute_info(self) -> OmniRouteInfo:
        """Fetch OmniRoute proxy internal status."""
        ops_data = self._run_opsctl_json("omniroute")
        if ops_data and isinstance(ops_data, dict):
            return OmniRouteInfo(
                status=str(ops_data.get("status", "UNKNOWN")),
                port=int(ops_data.get("port", 20128)),
                version=str(ops_data.get("version", "unknown")),
                active_requests=int(ops_data.get("active_requests", 0)),
                circuit_breakers=dict(ops_data.get("circuit_breakers", {})),
                cooldown_accounts=int(ops_data.get("cooldown_accounts", 0)),
            )
        return OmniRouteInfo(status="UNAVAILABLE", version="unknown")

    def get_deploy_info(self) -> DeployInfo:
        """Fetch current deployment information."""
        ops_data = self._run_opsctl_json("deploy")
        if ops_data and isinstance(ops_data, dict):
            return DeployInfo(
                current_commit=str(ops_data.get("current_commit", "unknown"))[:7],
                branch=str(ops_data.get("branch", "unknown")),
                version=str(ops_data.get("version", "unknown")),
                last_deploy_time=str(ops_data.get("last_deploy_time", "unknown")),
                status=str(ops_data.get("status", "UNKNOWN")),
                commit_message=str(ops_data.get("commit_message", "")),
            )
        return DeployInfo(
            current_commit="unknown",
            branch="unknown",
            version="unknown",
            last_deploy_time="unknown",
            status="UNAVAILABLE",
            commit_message="",
        )

    def get_logs(self, service_or_container: Optional[str] = None, lines: int = 50) -> str:
        """Read recent allow-listed service logs through the privileged helper."""
        allowed_services = {
            "app",
            "app-blue",
            "app-green",
            "caddy",
            "cloudflared",
            "redis",
            "omniroute-ops-bot",
            "portfolio",
            "tuan-portfolio",
            "tuan-portfolio-tunnel",
        }
        service = normalize_service_name(service_or_container)
        if service not in allowed_services:
            allowed_preview = "app, caddy, cloudflared, redis, bot, portfolio"
            return f"[Logs unavailable: service '{service}' is not allowed (allowed: {allowed_preview})]"
        payload = self._run_opsctl_args(
            ["logs", "--lines", str(min(max(1, lines), 200)), "--service", service],
            timeout=15.0,
        )
        if payload and isinstance(payload.get("logs"), str):
            return redact_sensitive(payload["logs"][-12000:])
        return "[Logs unavailable]"

    def get_backups_info(self) -> BackupInfo:
        """Fetch database and configuration backup status."""
        ops_data = self._run_opsctl_json("backups")
        if ops_data and isinstance(ops_data, dict):
            return BackupInfo(
                latest_backup_file=str(ops_data.get("latest_backup_file", "none")),
                latest_backup_time=str(ops_data.get("latest_backup_time", "unknown")),
                size_bytes=int(ops_data.get("size_bytes", 0)),
                status=str(ops_data.get("status", "UNKNOWN")),
                total_backups=int(ops_data.get("total_backups", 0)),
            )

        return BackupInfo(
            latest_backup_file="none",
            latest_backup_time="unknown",
            size_bytes=0,
            status="UNAVAILABLE",
            total_backups=0,
        )

    def get_security_metrics(self, state_manager: Optional[Any] = None) -> SecurityMetrics:
        """Collect security, firewall, and authentication health metrics."""
        ops_data = self._run_opsctl_json("security")
        locked_users_count = 0
        failed_auth_recent = 0

        if state_manager is not None:
            try:
                with state_manager._get_connection() as conn:
                    cursor = conn.cursor()
                    now = time.time()
                    cursor.execute("SELECT COUNT(*) FROM auth_attempts WHERE locked_until > ?", (now,))
                    locked_users_count = cursor.fetchone()[0]
                    cursor.execute(
                        "SELECT COUNT(*) FROM audit_log WHERE timestamp > ? AND status LIKE '%FAIL%'",
                        (now - 86400.0,),
                    )
                    failed_auth_recent = cursor.fetchone()[0]
            except Exception as e:
                logger.debug("Error querying state_manager for security metrics: %s", e)

        if ops_data and isinstance(ops_data, dict):
            return SecurityMetrics(
                firewall_status=str(ops_data.get("firewall_status", "ACTIVE (ufw)")),
                locked_users_count=int(ops_data.get("locked_users_count", locked_users_count)),
                failed_auth_recent=int(ops_data.get("failed_auth_recent", failed_auth_recent)),
                circuit_breaker_open_count=int(ops_data.get("circuit_breaker_open_count", 0)),
                open_tunnels=list(ops_data.get("open_tunnels", ["cloudflared: omniroute-edge"])),
            )

        return SecurityMetrics(
            firewall_status="ACTIVE (ufw)",
            locked_users_count=locked_users_count,
            failed_auth_recent=failed_auth_recent,
            circuit_breaker_open_count=0,
            open_tunnels=["cloudflared: omniroute-edge"],
        )
