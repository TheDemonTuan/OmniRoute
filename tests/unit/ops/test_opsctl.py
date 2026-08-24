"""Unit tests for OmniRoute VPS Operations Control Helper (omniroute_opsctl).

Tests all allowlisted subcommands, safety guards, JSON output schema compliance,
input validation, line bounding, and guarded rollback logic.
Uses Python 3.9 standard library unittest only.
"""

import fcntl
import gzip
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

from scripts.ops import omniroute_opsctl


class TestOpsctlPaths(unittest.TestCase):
    """Tests path resolution and directory overrides."""

    def test_get_paths_default(self) -> None:
        paths = omniroute_opsctl.get_paths("/opt/omniroute")
        self.assertEqual(paths["app_dir"], "/opt/omniroute")
        self.assertEqual(paths["compose_file"], "/opt/omniroute/compose.yml")
        self.assertEqual(paths["state_dir"], "/opt/omniroute/state")
        self.assertEqual(paths["data_dir"], "/opt/omniroute/data")
        self.assertEqual(paths["backups_dir"], "/opt/omniroute/backups")
        self.assertEqual(paths["active_slot_file"], "/opt/omniroute/state/active_slot")
        self.assertEqual(paths["prev_image_file"], "/opt/omniroute/state/previous_image")
        self.assertEqual(paths["deploy_lock_file"], "/opt/omniroute/state/deploy.lock")

    def test_get_paths_custom_app_dir(self) -> None:
        custom_dir = "/tmp/custom_omniroute"
        paths = omniroute_opsctl.get_paths(custom_dir)
        self.assertEqual(paths["app_dir"], custom_dir)
        self.assertEqual(paths["compose_file"], os.path.join(custom_dir, "compose.yml"))


class TestOpsctlSystemStatus(unittest.TestCase):
    """Tests host system metrics collection."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.paths = omniroute_opsctl.get_paths(self.temp_dir)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_system_status_schema(self) -> None:
        res = omniroute_opsctl.get_system_status(self.paths)
        expected_keys = {
            "hostname",
            "os_name",
            "uptime_seconds",
            "load_avg",
            "cpu_count",
            "cpu_usage_pct",
            "mem_total_mb",
            "mem_used_mb",
            "mem_free_mb",
            "mem_pct",
            "disk_total_gb",
            "disk_used_gb",
            "disk_free_gb",
            "disk_pct",
        }
        self.assertTrue(expected_keys.issubset(res.keys()))
        self.assertIsInstance(res["hostname"], str)
        self.assertIsInstance(res["load_avg"], list)
        self.assertEqual(len(res["load_avg"]), 3)
        self.assertIsInstance(res["cpu_count"], int)
        self.assertGreaterEqual(res["cpu_count"], 1)
        self.assertIsInstance(res["mem_total_mb"], float)
        self.assertIsInstance(res["disk_total_gb"], float)


class TestOpsctlContainersStatus(unittest.TestCase):
    """Tests container state querying."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.paths = omniroute_opsctl.get_paths(self.temp_dir)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    @patch("scripts.ops.omniroute_opsctl.safe_run_command")
    def test_containers_status_docker_ps_success(self, mock_run: MagicMock) -> None:
        sample_docker_output = (
            '{"ID":"a1b2c3d4e5f6","Names":"omniroute-app-blue-1","Status":"Up 3 days (healthy)","Image":"ghcr.io/omniroute@sha256:111"}\n'
            '{"ID":"f6e5d4c3b2a1","Names":"omniroute-caddy-1","Status":"Up 3 days","Image":"caddy:2-alpine"}\n'
        )
        mock_run.return_value = (0, sample_docker_output, "")

        res = omniroute_opsctl.get_containers_status(self.paths)
        containers = res.get("containers", [])
        self.assertEqual(len(containers), 2)
        self.assertEqual(containers[0]["name"], "omniroute-app-blue-1")
        self.assertEqual(containers[0]["id"], "a1b2c3d4e5f6")
        self.assertEqual(containers[0]["status"], "Up 3 days (healthy)")
        self.assertEqual(containers[1]["name"], "omniroute-caddy-1")

    @patch("scripts.ops.omniroute_opsctl.safe_run_command")
    def test_containers_status_docker_unavailable(self, mock_run: MagicMock) -> None:
        mock_run.return_value = (127, "", "docker not found")
        res = omniroute_opsctl.get_containers_status(self.paths)
        self.assertEqual(res, {"containers": []})


class TestOpsctlAppStatus(unittest.TestCase):
    """Tests OmniRoute proxy status and circuit breakers."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.paths = omniroute_opsctl.get_paths(self.temp_dir)
        os.makedirs(self.paths["state_dir"], exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    @patch("urllib.request.urlopen")
    def test_app_status_online(self, mock_urlopen: MagicMock) -> None:
        with open(self.paths["active_slot_file"], "w", encoding="utf-8") as f:
            f.write("blue\n")

        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = json.dumps({
            "status": "healthy",
            "version": "v3.8.42",
            "active_requests": 5,
            "cooldown_accounts": 1,
            "circuit_breakers": {
                "openai": "CLOSED",
                "anthropic": "CLOSED",
                "gemini": "OPEN",
                "openrouter": "CLOSED",
            },
        }).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        res = omniroute_opsctl.get_app_status(self.paths, port=20128)
        self.assertEqual(res["status"], "ONLINE")
        self.assertEqual(res["port"], 20128)
        self.assertEqual(res["version"], "v3.8.42")
        self.assertEqual(res["active_requests"], 5)
        self.assertEqual(res["cooldown_accounts"], 1)
        self.assertEqual(res["circuit_breakers"]["gemini"], "OPEN")
        self.assertEqual(res["active_slot"], "blue")

    @patch("urllib.request.urlopen")
    def test_app_status_offline(self, mock_urlopen: MagicMock) -> None:
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")
        res = omniroute_opsctl.get_app_status(self.paths, port=20128)
        self.assertEqual(res["status"], "OFFLINE")
        self.assertEqual(res["active_slot"], "none")
        self.assertEqual(res["active_requests"], 0)


class TestOpsctlDeployStatus(unittest.TestCase):
    """Tests deploy and git status reporting."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.paths = omniroute_opsctl.get_paths(self.temp_dir)
        os.makedirs(self.paths["state_dir"], exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_deploy_status_deployed(self) -> None:
        with open(self.paths["active_slot_file"], "w", encoding="utf-8") as f:
            f.write("green\n")

        with open(self.paths["prev_image_file"], "w", encoding="utf-8") as f:
            f.write("ghcr.io/owner/omniroute@sha256:0000000000000000000000000000000000000000000000000000000000000000\n")

        with open(self.paths["deploy_env"], "w", encoding="utf-8") as f:
            f.write("BLUE_IMAGE=ghcr.io/owner/omniroute@sha256:0000000000000000000000000000000000000000000000000000000000000000\n")
            f.write("GREEN_IMAGE=ghcr.io/owner/omniroute@sha256:1111111111111111111111111111111111111111111111111111111111111111\n")

        res = omniroute_opsctl.get_deploy_status(self.paths)
        self.assertEqual(res["status"], "DEPLOYED")
        self.assertEqual(res["active_slot"], "green")
        self.assertEqual(res["current_commit"], "1111111")
        self.assertIn("1111111", res["green_image"])
        self.assertIn("0000000", res["previous_image"])

    def test_deploy_status_not_deployed(self) -> None:
        res = omniroute_opsctl.get_deploy_status(self.paths)
        self.assertEqual(res["status"], "NOT_DEPLOYED")
        self.assertEqual(res["active_slot"], "none")


class TestOpsctlLogs(unittest.TestCase):
    """Tests bounded log retrieval and service allowlisting."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.paths = omniroute_opsctl.get_paths(self.temp_dir)
        os.makedirs(self.paths["state_dir"], exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    @patch("scripts.ops.omniroute_opsctl.safe_run_command")
    def test_logs_allowlisted_service(self, mock_run: MagicMock) -> None:
        mock_run.return_value = (0, "2026-08-24 12:00:00 INFO Service started", "")
        res = omniroute_opsctl.get_logs(self.paths, service="caddy", lines=20)
        self.assertEqual(res["status"], "SUCCESS")
        self.assertEqual(res["service"], "caddy")
        self.assertEqual(res["lines"], 20)
        self.assertIn("Service started", res["logs"])

    def test_logs_disallowed_service(self) -> None:
        res = omniroute_opsctl.get_logs(self.paths, service="evil_service", lines=50)
        self.assertEqual(res["status"], "ERROR")
        self.assertIn("not in allowed log services", res["error"])

    @patch("scripts.ops.omniroute_opsctl.safe_run_command")
    def test_logs_bounded_lines(self, mock_run: MagicMock) -> None:
        mock_run.return_value = (0, "log line", "")
        res_high = omniroute_opsctl.get_logs(self.paths, service="redis", lines=9999)
        self.assertEqual(res_high["lines"], omniroute_opsctl.MAX_LOG_LINES)

        res_low = omniroute_opsctl.get_logs(self.paths, service="redis", lines=-10)
        self.assertEqual(res_low["lines"], omniroute_opsctl.MIN_LOG_LINES)


class TestOpsctlBackups(unittest.TestCase):
    """Tests SQLite database backup listing, creation, and integrity verification."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.paths = omniroute_opsctl.get_paths(self.temp_dir)
        os.makedirs(self.paths["backups_dir"], exist_ok=True)
        os.makedirs(self.paths["data_dir"], exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_backups_status_empty(self) -> None:
        res = omniroute_opsctl.get_backups_status(self.paths)
        self.assertEqual(res["status"], "NONE")
        self.assertEqual(res["total_backups"], 0)
        self.assertEqual(res["latest_backup_file"], "none")

    def test_backups_status_with_files(self) -> None:
        b1 = os.path.join(self.paths["backups_dir"], "storage-20260824T030000Z.sqlite.gz")
        b2 = os.path.join(self.paths["backups_dir"], "storage-20260824T040000Z.sqlite.gz")
        with open(b1, "wb") as f:
            f.write(b"data1")
        with open(b2, "wb") as f:
            f.write(b"data2")

        res = omniroute_opsctl.get_backups_status(self.paths)
        self.assertEqual(res["status"], "VERIFIED")
        self.assertEqual(res["total_backups"], 2)
        self.assertEqual(res["latest_backup_file"], "storage-20260824T040000Z.sqlite.gz")

    @patch("scripts.ops.omniroute_opsctl.safe_run_command")
    def test_create_backup_via_script(self, mock_run: MagicMock) -> None:
        # Create mock backup.sh
        with open(self.paths["backup_script"], "w", encoding="utf-8") as f:
            f.write("#!/bin/bash\nexit 0\n")
        os.chmod(self.paths["backup_script"], 0o755)

        # Create expected backup file
        b_file = os.path.join(self.paths["backups_dir"], "storage-20260824T050000Z.sqlite.gz")
        with open(b_file, "wb") as f:
            f.write(b"backup_content")

        mock_run.return_value = (0, "ok", "")
        res = omniroute_opsctl.create_backup(self.paths)
        self.assertEqual(res["status"], "SUCCESS")
        self.assertTrue(res["verified"])
        self.assertEqual(res["file"], "storage-20260824T050000Z.sqlite.gz")

    def test_check_backup_valid_gzip(self) -> None:
        b_file = os.path.join(self.paths["backups_dir"], "storage-test.sqlite.gz")
        with gzip.open(b_file, "wb") as gz:
            gz.write(b"SQLite format 3\x00")

        res = omniroute_opsctl.check_backup(self.paths, backup_file="storage-test.sqlite.gz")
        self.assertEqual(res["status"], "VERIFIED")
        self.assertEqual(res["integrity"], "ok")

    def test_check_backup_corrupt_gzip(self) -> None:
        b_file = os.path.join(self.paths["backups_dir"], "storage-corrupt.sqlite.gz")
        with open(b_file, "wb") as f:
            f.write(b"NOT_A_VALID_GZIP_STREAM")

        res = omniroute_opsctl.check_backup(self.paths, backup_file="storage-corrupt.sqlite.gz")
        self.assertEqual(res["status"], "CORRUPT")


class TestOpsctlRestart(unittest.TestCase):
    """Tests safe restart of allowlisted services."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.paths = omniroute_opsctl.get_paths(self.temp_dir)
        os.makedirs(self.paths["state_dir"], exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    @patch("scripts.ops.omniroute_opsctl.safe_run_command")
    def test_restart_allowed_service(self, mock_run: MagicMock) -> None:
        mock_run.return_value = (0, "caddy restarted", "")
        res = omniroute_opsctl.restart_service(self.paths, "caddy")
        self.assertEqual(res["status"], "SUCCESS")
        self.assertEqual(res["service"], "caddy")

    def test_restart_disallowed_service(self) -> None:
        res = omniroute_opsctl.restart_service(self.paths, "dangerous_daemon")
        self.assertEqual(res["status"], "ERROR")
        self.assertIn("not in allowed restart services list", res["error"])


class TestOpsctlGuardedRollback(unittest.TestCase):
    """Tests rollback safety gates: deploy lock check, pre-backup, deploy.sh call, post-health."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.paths = omniroute_opsctl.get_paths(self.temp_dir)
        os.makedirs(self.paths["state_dir"], exist_ok=True)
        os.makedirs(self.paths["backups_dir"], exist_ok=True)
        os.makedirs(self.paths["data_dir"], exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_rollback_locked_fails(self) -> None:
        # Acquire lock in current process to simulate concurrent deployment
        lock_fd = os.open(self.paths["deploy_lock_file"], os.O_CREAT | os.O_RDWR, 0o644)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

        try:
            res = omniroute_opsctl.execute_guarded_rollback(self.paths)
            self.assertEqual(res["status"], "ERROR")
            self.assertIn("Deploy lock is held", res["error"])
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)

    def test_rollback_no_previous_image_fails(self) -> None:
        # Lock is available, but previous_image file is absent
        res = omniroute_opsctl.execute_guarded_rollback(self.paths)
        self.assertEqual(res["status"], "ERROR")
        self.assertIn("No previous image recorded", res["error"])

    @patch("scripts.ops.omniroute_opsctl.create_backup")
    def test_rollback_backup_failure_aborts(self, mock_backup: MagicMock) -> None:
        with open(self.paths["prev_image_file"], "w", encoding="utf-8") as f:
            f.write("ghcr.io/owner/omniroute@sha256:prev111\n")

        mock_backup.return_value = {"status": "ERROR", "error": "Disk full", "verified": False}

        res = omniroute_opsctl.execute_guarded_rollback(self.paths)
        self.assertEqual(res["status"], "ERROR")
        self.assertIn("Pre-rollback database backup failed", res["error"])

    @patch("scripts.ops.omniroute_opsctl.get_app_status")
    @patch("scripts.ops.omniroute_opsctl.safe_run_command")
    @patch("scripts.ops.omniroute_opsctl.create_backup")
    def test_rollback_success(
        self,
        mock_backup: MagicMock,
        mock_run: MagicMock,
        mock_app_status: MagicMock,
    ) -> None:
        with open(self.paths["prev_image_file"], "w", encoding="utf-8") as f:
            f.write("ghcr.io/owner/omniroute@sha256:prev111\n")

        with open(self.paths["deploy_script"], "w", encoding="utf-8") as f:
            f.write("#!/bin/bash\nexit 0\n")
        os.chmod(self.paths["deploy_script"], 0o755)

        mock_backup.return_value = {
            "status": "SUCCESS",
            "file": "storage-pre-rollback.sqlite.gz",
            "verified": True,
        }
        mock_run.return_value = (0, "DEPLOYMENT SUCCESS", "")
        mock_app_status.return_value = {
            "status": "ONLINE",
            "port": 20128,
            "version": "v3.8.42",
        }

        res = omniroute_opsctl.execute_guarded_rollback(self.paths)
        self.assertEqual(res["status"], "SUCCESS")
        self.assertEqual(res["action"], "rollback")
        self.assertEqual(res["previous_image"], "ghcr.io/owner/omniroute@sha256:prev111")
        self.assertEqual(res["backup_file"], "storage-pre-rollback.sqlite.gz")
        self.assertEqual(res["post_health"]["status"], "ONLINE")


class TestOpsctlSecurityStatus(unittest.TestCase):
    """Tests security, firewall, and tunnel metrics."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()
        self.paths = omniroute_opsctl.get_paths(self.temp_dir)

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    @patch("scripts.ops.omniroute_opsctl.get_containers_status")
    @patch("scripts.ops.omniroute_opsctl.safe_run_command")
    def test_security_status(self, mock_run: MagicMock, mock_c: MagicMock) -> None:
        mock_run.return_value = (0, "Status: active\nTo Action From\n-- ------ ----\n22/tcp ALLOW Anywhere", "")
        mock_c.return_value = {
            "containers": [
                {"name": "omniroute-cloudflared-1", "status": "Up 2 days", "id": "123456789012"},
            ]
        }

        res = omniroute_opsctl.get_security_status(self.paths)
        self.assertIn("active (ufw)", res["firewall_status"])
        self.assertIn("cloudflared", res["open_tunnels"])
        self.assertEqual(res["circuit_breaker_open_count"], 0)


class TestOpsctlCliMain(unittest.TestCase):
    """Tests CLI entrypoint and argument parsing."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self) -> None:
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    @patch("sys.stdout")
    def test_cli_system_json(self, mock_stdout: MagicMock) -> None:
        code = omniroute_opsctl.main(["system", "--app-dir", self.temp_dir, "--json"])
        self.assertEqual(code, 0)

    @patch("sys.stdout")
    def test_cli_backups_list(self, mock_stdout: MagicMock) -> None:
        code = omniroute_opsctl.main(["backups", "list", "--app-dir", self.temp_dir, "--json"])
        self.assertEqual(code, 0)

    @patch("sys.stdout")
    def test_cli_restart_disallowed(self, mock_stdout: MagicMock) -> None:
        code = omniroute_opsctl.main(["restart", "--service", "forbidden_svc", "--app-dir", self.temp_dir])
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
