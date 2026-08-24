"""Unit tests for host and container metric collection, opsctl parsing, and GitHub client."""

import json
import subprocess
import unittest
from unittest.mock import MagicMock, patch

from scripts.ops.telegram_ops_bot.metrics import (
    BackupInfo,
    ContainerInfo,
    DeployInfo,
    GitHubClient,
    HostMetrics,
    MetricsCollector,
    OmniRouteInfo,
    SecurityMetrics,
)


class TestMetrics(unittest.TestCase):
    """Test suite for MetricsCollector and GitHubClient."""

    def test_github_client_unconfigured(self) -> None:
        client = GitHubClient()
        self.assertFalse(client.is_configured())
        self.assertIsNone(client.get_latest_release())
        self.assertEqual(client.get_recent_commits(), [])

        client_token_only = GitHubClient(token="ghp_123")
        self.assertFalse(client_token_only.is_configured())

    @patch("urllib.request.urlopen")
    def test_github_client_configured_success(self, mock_urlopen: MagicMock) -> None:
        client = GitHubClient(token="ghp_12345", repo="org/omniroute")
        self.assertTrue(client.is_configured())

        # Mock latest release response
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({
            "tag_name": "v3.8.42",
            "name": "OmniRoute v3.8.42 Stable",
            "published_at": "2026-08-20T12:00:00Z",
            "html_url": "https://github.com/org/omniroute/releases/tag/v3.8.42",
        }).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        release = client.get_latest_release()
        self.assertIsNotNone(release)
        self.assertEqual(release["tag_name"], "v3.8.42")
        self.assertEqual(release["name"], "OmniRoute v3.8.42 Stable")

    @patch("subprocess.run")
    def test_opsctl_host_metrics_success(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=["opsctl", "system", "--json"],
            returncode=0,
            stdout=json.dumps({
                "hostname": "prod-vps-01",
                "os_name": "Linux 6.8.0-generic",
                "uptime_seconds": 345600,
                "load_avg": [0.45, 0.52, 0.60],
                "cpu_count": 8,
                "cpu_usage_pct": 24.5,
                "mem_total_mb": 16384.0,
                "mem_used_mb": 4096.0,
                "mem_free_mb": 12288.0,
                "mem_pct": 25.0,
                "disk_total_gb": 250.0,
                "disk_used_gb": 50.0,
                "disk_free_gb": 200.0,
                "disk_pct": 20.0,
            }),
            stderr="",
        )

        collector = MetricsCollector(opsctl_path="/usr/bin/opsctl")
        with patch("os.geteuid", return_value=1000):
            metrics = collector.get_host_metrics()
        self.assertIsInstance(metrics, HostMetrics)
        self.assertEqual(
            mock_run.call_args.args[0],
            ["sudo", "-n", "/usr/bin/opsctl", "system", "--json"],
        )
        self.assertEqual(metrics.hostname, "prod-vps-01")
        self.assertEqual(metrics.cpu_count, 8)
        self.assertEqual(metrics.cpu_usage_pct, 24.5)
        self.assertEqual(metrics.mem_used_mb, 4096.0)
        self.assertEqual(metrics.disk_pct, 20.0)

    @patch("subprocess.run")
    @patch("os.geteuid", return_value=1000)
    def test_opsctl_fixed_operations_use_sudo_and_argument_arrays(
        self,
        _mock_geteuid: MagicMock,
        mock_run: MagicMock,
    ) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"status":"SUCCESS"}',
            stderr="",
        )
        collector = MetricsCollector(opsctl_path="/usr/local/sbin/omniroute-opsctl")

        collector.perform_operation("backup")
        collector.perform_operation("restart", "caddy")
        collector.perform_operation("rollback")

        self.assertEqual(
            [call.args[0] for call in mock_run.call_args_list],
            [
                ["sudo", "-n", "/usr/local/sbin/omniroute-opsctl", "backups", "create", "--json"],
                ["sudo", "-n", "/usr/local/sbin/omniroute-opsctl", "restart", "--service", "caddy", "--json"],
                ["sudo", "-n", "/usr/local/sbin/omniroute-opsctl", "rollback", "--json"],
            ],
        )

    def test_opsctl_operation_rejects_unknown_target(self) -> None:
        collector = MetricsCollector(opsctl_path="/usr/local/sbin/omniroute-opsctl")
        result = collector.perform_operation("restart", "attacker-controlled")
        self.assertEqual(result["status"], "ERROR")

    @patch("subprocess.run")
    @patch("os.geteuid", return_value=1000)
    def test_logs_use_sudo_and_reject_unknown_service(
        self,
        _mock_geteuid: MagicMock,
        mock_run: MagicMock,
    ) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"logs":"safe log line"}',
            stderr="",
        )
        collector = MetricsCollector(opsctl_path="/usr/local/sbin/omniroute-opsctl")

        logs = collector.get_logs("caddy", lines=25)
        rejected = collector.get_logs("attacker-controlled")

        self.assertEqual(logs, "safe log line")
        self.assertIn("not allowed", rejected)
        self.assertEqual(
            mock_run.call_args.args[0],
            [
                "sudo",
                "-n",
                "/usr/local/sbin/omniroute-opsctl",
                "logs",
                "--lines",
                "25",
                "--service",
                "caddy",
                "--json",
            ],
        )
        self.assertEqual(mock_run.call_count, 1)

    @patch("subprocess.run")
    @patch("os.geteuid", return_value=0)
    def test_root_runs_opsctl_without_sudo(
        self,
        _mock_geteuid: MagicMock,
        mock_run: MagicMock,
    ) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="{}",
            stderr="",
        )

        MetricsCollector(opsctl_path="/usr/local/sbin/omniroute-opsctl")._run_opsctl_json(
            "system"
        )

        self.assertEqual(
            mock_run.call_args.args[0],
            ["/usr/local/sbin/omniroute-opsctl", "system", "--json"],
        )

    @patch("subprocess.run")
    def test_opsctl_containers_parsing(self, mock_run: MagicMock) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=["opsctl", "containers", "--json"],
            returncode=0,
            stdout=json.dumps({
                "containers": [
                    {
                        "name": "omniroute-core",
                        "id": "112233445566",
                        "status": "running (healthy)",
                        "image": "omniroute/core:v3.8.42",
                        "cpu_pct": 2.1,
                        "mem_usage_mb": 210.5,
                        "mem_limit_mb": 1024.0,
                    }
                ]
            }),
            stderr="",
        )

        collector = MetricsCollector(opsctl_path="opsctl")
        containers = collector.get_containers()
        self.assertEqual(len(containers), 1)
        self.assertEqual(containers[0].name, "omniroute-core")
        self.assertEqual(containers[0].status, "running (healthy)")
        self.assertEqual(containers[0].cpu_pct, 2.1)

    @patch("subprocess.run")
    def test_opsctl_omniroute_and_deploy_parsing(self, mock_run: MagicMock) -> None:
        def side_effect(cmd, *args, **kwargs):
            subcommand = cmd[-2]
            if subcommand == "omniroute":
                return subprocess.CompletedProcess(
                    args=cmd,
                    returncode=0,
                    stdout=json.dumps({
                        "status": "ONLINE",
                        "port": 20128,
                        "version": "v3.8.42",
                        "active_requests": 5,
                        "circuit_breakers": {"openai": "CLOSED", "anthropic": "OPEN"},
                        "cooldown_accounts": 1,
                    }),
                    stderr="",
                )
            elif subcommand == "deploy":
                return subprocess.CompletedProcess(
                    args=cmd,
                    returncode=0,
                    stdout=json.dumps({
                        "current_commit": "abcdef123456",
                        "branch": "release/v3.8.42",
                        "version": "v3.8.42",
                        "last_deploy_time": "2026-08-24 09:00 UTC",
                        "status": "SUCCESS",
                        "commit_message": "fix: circuit breaker state",
                    }),
                    stderr="",
                )
            return subprocess.CompletedProcess(args=cmd, returncode=1, stdout="", stderr="error")

        mock_run.side_effect = side_effect
        collector = MetricsCollector(opsctl_path="opsctl")

        omni = collector.get_omniroute_info()
        self.assertEqual(omni.status, "ONLINE")
        self.assertEqual(omni.circuit_breakers.get("anthropic"), "OPEN")
        self.assertEqual(omni.cooldown_accounts, 1)

        dep = collector.get_deploy_info()
        self.assertEqual(dep.current_commit, "abcdef1")
        self.assertEqual(dep.branch, "release/v3.8.42")
        self.assertEqual(dep.commit_message, "fix: circuit breaker state")

    def test_metrics_collector_proc_fallback(self) -> None:
        # Invalid opsctl path to test fallback routines without exceptions
        collector = MetricsCollector(opsctl_path="/nonexistent/opsctl")
        metrics = collector.get_host_metrics()
        self.assertIsInstance(metrics, HostMetrics)
        self.assertGreaterEqual(metrics.cpu_count, 1)
        self.assertGreaterEqual(metrics.disk_total_gb, 0.0)

        containers = collector.get_containers()
        self.assertEqual(containers, [])

    @patch("subprocess.run")
    @patch("os.geteuid", return_value=0)
    def test_get_logs_sanitization_and_arguments(
        self,
        _mock_geteuid: MagicMock,
        mock_run: MagicMock,
    ) -> None:
        mock_run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps({
                "logs": "2026-08-24 INFO Authorization: Bearer secret_bearer_token_123456789 from client\n"
            }),
            stderr="",
        )

        collector = MetricsCollector(opsctl_path="opsctl")
        logs = collector.get_logs(service_or_container="app", lines=30)
        self.assertNotIn("secret_bearer_token_123456789", logs)
        self.assertIn("[REDACTED_BEARER]", logs)

        self.assertEqual(
            mock_run.call_args.args[0],
            ["opsctl", "logs", "--lines", "30", "--service", "app", "--json"],
        )

    def test_subcommand_whitelist_guard(self) -> None:
        collector = MetricsCollector(opsctl_path="opsctl")
        # Attempt to run arbitrary or unlisted subcommand
        res = collector._run_opsctl_json("arbitrary_command; rm -rf /")
        self.assertIsNone(res)


if __name__ == "__main__":
    unittest.main()
