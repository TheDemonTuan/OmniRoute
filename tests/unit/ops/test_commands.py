"""Unit tests for Telegram Ops Bot command handlers, dispatching, and callbacks."""

import tempfile
import unittest
from unittest.mock import MagicMock

from scripts.ops.telegram_ops_bot.commands import CommandDispatcher
from scripts.ops.telegram_ops_bot.config import BotConfig
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
from scripts.ops.telegram_ops_bot.security import hash_pin
from scripts.ops.telegram_ops_bot.state import StateManager
from scripts.ops.telegram_ops_bot.telegram import TelegramClient


class TestCommands(unittest.TestCase):
    """Test suite for CommandDispatcher."""

    def setUp(self) -> None:
        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.state = StateManager(db_path=self.temp_db.name)

        # Generate a test PIN hash (PIN = 123456)
        pin_hash, pin_salt = hash_pin("123456")

        self.config = BotConfig(
            bot_token="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234",
            allowed_user_ids={1001},
            allowed_chat_ids={2001},
            pin_hash=pin_hash,
            pin_salt=pin_salt,
            db_path=self.temp_db.name,
            require_private_chat=True,
        )

        self.mock_metrics = MagicMock(spec=MetricsCollector)
        self.mock_metrics.get_host_metrics.return_value = HostMetrics(
            hostname="test-node",
            os_name="Linux 6.8",
            uptime_seconds=90000,
            load_avg=(0.10, 0.20, 0.30),
            cpu_count=4,
            cpu_usage_pct=15.0,
            mem_total_mb=8192.0,
            mem_used_mb=2048.0,
            mem_free_mb=6144.0,
            mem_pct=25.0,
            disk_total_gb=100.0,
            disk_used_gb=30.0,
            disk_free_gb=70.0,
            disk_pct=30.0,
        )
        self.mock_metrics.get_omniroute_info.return_value = OmniRouteInfo(
            status="ONLINE",
            port=20128,
            version="v3.8.42",
            active_requests=2,
            circuit_breakers={"openai": "CLOSED", "gemini": "CLOSED"},
            cooldown_accounts=0,
        )
        self.mock_metrics.get_containers.return_value = [
            ContainerInfo(
                name="omniroute-app",
                id="a1b2c3d4e5f6",
                status="running (healthy)",
                image="omniroute:latest",
                cpu_pct=1.5,
                mem_usage_mb=150.0,
                mem_limit_mb=1024.0,
            )
        ]
        self.mock_metrics.get_deploy_info.return_value = DeployInfo(
            current_commit="1a2b3c4",
            branch="release/v3.8.42",
            version="v3.8.42",
            last_deploy_time="2026-08-24 10:00 UTC",
            status="SUCCESS",
            commit_message="feat: ops bot core",
        )
        self.mock_metrics.get_logs.return_value = "2026-08-24 10:00:00 INFO Service started normally\n"
        self.mock_metrics.get_backups_info.return_value = BackupInfo(
            latest_backup_file="backup-2026-08-24.sqlite.gz",
            latest_backup_time="2026-08-24 02:00 UTC",
            size_bytes=10485760,
            status="SUCCESS",
            total_backups=5,
        )
        self.mock_metrics.get_security_metrics.return_value = SecurityMetrics(
            firewall_status="ACTIVE (ufw)",
            locked_users_count=0,
            failed_auth_recent=0,
            circuit_breaker_open_count=0,
            open_tunnels=["cloudflared: omniroute-edge"],
        )
        self.mock_metrics.github_client = MagicMock()
        self.mock_metrics.github_client.is_configured.return_value = False

        self.mock_telegram = MagicMock(spec=TelegramClient)

        self.dispatcher = CommandDispatcher(
            config=self.config,
            state=self.state,
            metrics=self.mock_metrics,
            telegram=self.mock_telegram,
        )

    def test_handle_status_and_start_command(self) -> None:
        msg = {
            "from": {"id": 1001, "username": "operator"},
            "chat": {"id": 2001, "type": "private"},
            "text": "/status",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        args, kwargs = self.mock_telegram.send_message.call_args
        self.assertEqual(kwargs.get("chat_id"), 2001)
        self.assertIn("OmniRoute Ops Dashboard", kwargs["text"])
        self.assertIn("v3.8.42", kwargs["text"])
        self.assertIn("1d 1h 0m", kwargs["text"])  # 90000s = 1d 1h 0m
        self.assertIn("inline_keyboard", kwargs["reply_markup"])

        # Check audit log recorded
        audits = self.state.get_recent_audit_logs()
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0]["command"], "/status")
        self.assertEqual(audits[0]["status"], "SUCCESS")

    def test_handle_system_command(self) -> None:
        msg = {
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/system",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("System Resource Metrics", kwargs["text"])
        self.assertIn("test-node", kwargs["text"])
        self.assertIn("Memory Total:", kwargs["text"])

    def test_handle_containers_command(self) -> None:
        msg = {
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/containers",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("Container Status", kwargs["text"])
        self.assertIn("omniroute-app", kwargs["text"])

    def test_handle_containers_empty_fallback(self) -> None:
        self.mock_metrics.get_containers.return_value = []
        msg = {
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/containers",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("No containers found or docker daemon query timed out", kwargs["text"])

    def test_handle_omniroute_command(self) -> None:
        msg = {
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/omniroute",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("OmniRoute AI Proxy Engine", kwargs["text"])
        self.assertIn("openai:", kwargs["text"])

    def test_handle_deploy_command(self) -> None:
        msg = {
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/deploy",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("Deployment & Version Information", kwargs["text"])
        self.assertIn("1a2b3c4", kwargs["text"])

    def test_handle_logs_command(self) -> None:
        msg = {
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/logs omniroute-app",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("Recent Logs", kwargs["text"])
        self.assertIn("<pre>", kwargs["text"])
        self.assertIn("Service started normally", kwargs["text"])

    def test_handle_backups_command(self) -> None:
        msg = {
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/backups",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("Database & Config Backups", kwargs["text"])
        self.assertIn("backup-2026-08-24.sqlite.gz", kwargs["text"])

    def test_handle_security_command(self) -> None:
        msg = {
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/security",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("Security & Access Posture", kwargs["text"])
        self.assertIn("ACTIVE (ufw)", kwargs["text"])

    def test_handle_upstream_distinguishes_default_and_newest_branch(self) -> None:
        self.dispatcher.upstream = MagicMock()
        self.dispatcher.upstream.get_upstream_default_branch.return_value = "release/v3.8.50"
        self.dispatcher.upstream.get_highest_upstream_release.return_value = "release/v3.8.51"
        self.dispatcher.upstream.compare_commits.return_value = {
            "status": "ahead",
            "ahead_by": 32,
            "behind_by": 0,
            "commits": [],
        }

        text, _keyboard = self.dispatcher.handle_upstream()

        self.assertIn("Default branch:</b> <code>release/v3.8.50", text)
        self.assertIn("Newest release branch:</b> <code>release/v3.8.51", text)
        self.assertIn("not the current default branch", text)

    def test_handle_help_command(self) -> None:
        msg = {
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/help",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("OmniRoute Telegram Ops Bot Commands", kwargs["text"])
        self.assertIn("/status", kwargs["text"])
        self.assertIn("/security", kwargs["text"])

    def test_confirm_deletes_cleartext_pin_message(self) -> None:
        nonce = self.state.create_pending_action(
            user_id=1001,
            action_type="deploy",
            payload={},
        )
        message = {
            "message_id": 4321,
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": f"/confirm {nonce} 123456",
        }
        self.dispatcher._execute_action = MagicMock(return_value="✅ deployed")

        self.dispatcher.dispatch_message(message)

        self.mock_telegram.delete_message.assert_called_once_with(2001, 4321)
        self.dispatcher._execute_action.assert_called_once_with("deploy", {})
        audits = self.state.get_recent_audit_logs()
        self.assertEqual(audits[0]["args"], f"{nonce} [REDACTED_PIN]")
        self.assertNotIn("123456", audits[0]["args"])

    def test_malformed_confirm_also_deletes_possible_pin_message(self) -> None:
        message = {
            "message_id": 4322,
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/confirm possible-cleartext-pin",
        }

        self.dispatcher.dispatch_message(message)

        self.mock_telegram.delete_message.assert_called_once_with(2001, 4322)
        audits = self.state.get_recent_audit_logs()
        self.assertEqual(audits[0]["args"], "[REDACTED_PIN]")
        self.assertNotIn("possible-cleartext-pin", audits[0]["args"])

    def test_unauthorized_user_rejection(self) -> None:
        msg = {
            "from": {"id": 9999},  # Unauthorized user
            "chat": {"id": 2001, "type": "private"},
            "text": "/status",
        }
        self.dispatcher.dispatch_message(msg)

        # Telegram message should NOT be sent to unauthorized user
        self.mock_telegram.send_message.assert_not_called()

        # Audit log should record DENIED
        audits = self.state.get_recent_audit_logs()
        self.assertEqual(len(audits), 1)
        self.assertEqual(audits[0]["status"], "DENIED")

    def test_group_chat_rejection_when_private_required(self) -> None:
        msg = {
            "from": {"id": 1001},
            "chat": {"id": -100999999, "type": "group"},  # Group chat
            "text": "/status",
        }
        self.dispatcher.dispatch_message(msg)

        # Warning message sent about private requirement
        self.mock_telegram.send_message.assert_called_once()
        args, kwargs = self.mock_telegram.send_message.call_args
        chat_id = kwargs.get("chat_id") if "chat_id" in kwargs else (args[0] if args else None)
        text = kwargs.get("text") if "text" in kwargs else (args[1] if len(args) > 1 else "")
        self.assertEqual(chat_id, -100999999)
        self.assertIn("Access Denied", text)

    def test_callback_query_dispatch(self) -> None:
        callback = {
            "id": "cb_12345",
            "from": {"id": 1001},
            "message": {
                "message_id": 555,
                "chat": {"id": 2001, "type": "private"},
            },
            "data": "refresh:status",
        }
        self.dispatcher.dispatch_callback_query(callback)

        self.mock_telegram.answer_callback_query.assert_called_once_with("cb_12345", text="Updated")
        self.mock_telegram.edit_message_text.assert_called_once()
        args, kwargs = self.mock_telegram.edit_message_text.call_args
        self.assertEqual(kwargs["chat_id"], 2001)
        self.assertEqual(kwargs["message_id"], 555)
        self.assertIn("OmniRoute Ops Dashboard", kwargs["text"])

    def test_callback_without_chat_context_is_denied(self) -> None:
        callback = {
            "id": "cb_missing_chat",
            "from": {"id": 1001},
            "data": "prepare:deploy",
        }

        self.dispatcher.dispatch_callback_query(callback)

        self.mock_telegram.answer_callback_query.assert_called_once()
        _, kwargs = self.mock_telegram.answer_callback_query.call_args
        self.assertTrue(kwargs["show_alert"])
        self.mock_telegram.edit_message_text.assert_not_called()

    def test_callback_with_unauthorized_user_is_denied(self) -> None:
        callback = {
            "id": "cb_bad_user",
            "from": {"id": 9999},
            "message": {
                "message_id": 555,
                "chat": {"id": 2001, "type": "private"},
            },
            "data": "prepare:deploy",
        }

        self.dispatcher.dispatch_callback_query(callback)

        self.mock_telegram.answer_callback_query.assert_called_once()
        _, kwargs = self.mock_telegram.answer_callback_query.call_args
        self.assertTrue(kwargs["show_alert"])
        self.assertIsNone(self.state.get_pending_action("cb_bad_user"))

    def test_prepare_backup_uses_button_confirmation(self) -> None:
        callback = {
            "id": "cb_backup",
            "from": {"id": 1001},
            "message": {
                "message_id": 556,
                "chat": {"id": 2001, "type": "private"},
            },
            "data": "prepare:backup",
        }

        self.dispatcher.dispatch_callback_query(callback)

        _, kwargs = self.mock_telegram.edit_message_text.call_args
        button = kwargs["reply_markup"]["inline_keyboard"][0][0]
        self.assertEqual(button["text"], "✅ Confirm")
        self.assertTrue(button["callback_data"].startswith("execute:"))

    def test_prepare_rollback_requires_pin(self) -> None:
        callback = {
            "id": "cb_rollback",
            "from": {"id": 1001},
            "message": {
                "message_id": 557,
                "chat": {"id": 2001, "type": "private"},
            },
            "data": "prepare:rollback",
        }

        self.dispatcher.dispatch_callback_query(callback)

        _, kwargs = self.mock_telegram.edit_message_text.call_args
        self.assertIn("YOUR_PIN", kwargs["text"])
        self.assertNotIn("execute:", str(kwargs["reply_markup"]))

    def test_execute_host_operations_through_metrics_collector(self) -> None:
        self.mock_metrics.perform_operation.side_effect = [
            {"status": "SUCCESS", "file": "backup.sqlite.gz"},
            {"status": "SUCCESS", "service": "app"},
            {"status": "SUCCESS", "action": "rollback"},
        ]

        backup_text = self.dispatcher._execute_action("backup", {})
        restart_text = self.dispatcher._execute_action("restart", {"target": "app"})
        rollback_text = self.dispatcher._execute_action("rollback", {})

        self.assertIn("SUCCESS", backup_text)
        self.assertIn("SUCCESS", restart_text)
        self.assertIn("SUCCESS", rollback_text)
        self.assertEqual(
            self.mock_metrics.perform_operation.call_args_list,
            [
                unittest.mock.call("backup", ""),
                unittest.mock.call("restart", "app"),
                unittest.mock.call("rollback", ""),
            ],
        )

    def test_build_dispatch_uses_string_boolean_input(self) -> None:
        self.dispatcher.actions = MagicMock()
        self.dispatcher.actions.dispatch_workflow.return_value = {
            "correlation_id": "ops-123"
        }

        self.dispatcher._execute_action("build", {})

        self.dispatcher.actions.dispatch_workflow.assert_called_once_with(
            "prod-deploy.yml",
            "prod",
            inputs={"skip_deploy": "true"},
        )

    def test_pin_verification_fails_closed_when_unconfigured(self) -> None:
        config = BotConfig(
            bot_token=self.config.bot_token,
            allowed_user_ids={1001},
            allowed_chat_ids={2001},
            db_path=self.temp_db.name,
        )
        dispatcher = CommandDispatcher(config, self.state, self.mock_metrics, self.mock_telegram)
        ok, message = dispatcher.verify_operator_pin(1001, "123456")
        self.assertFalse(ok)
        self.assertIn("disabled", message)

    def test_pin_verification_flow(self) -> None:
        user_id = 1001

        # Correct PIN
        ok, msg = self.dispatcher.verify_operator_pin(user_id, "123456")
        self.assertTrue(ok)
        self.assertIn("PIN verified", msg)

        # Incorrect PIN
        ok, msg = self.dispatcher.verify_operator_pin(user_id, "wrong")
        self.assertFalse(ok)
        self.assertIn("Attempt 1/3", msg)

        # Second failure
        ok, msg = self.dispatcher.verify_operator_pin(user_id, "wrong2")
        self.assertFalse(ok)
        self.assertIn("Attempt 2/3", msg)

        # Third failure -> lockout
        ok, msg = self.dispatcher.verify_operator_pin(user_id, "wrong3")
        self.assertFalse(ok)
        self.assertIn("Account locked", msg)

        # While locked out
        ok, msg = self.dispatcher.verify_operator_pin(user_id, "123456")
        self.assertFalse(ok)
        self.assertIn("Account locked", msg)


class TestTelegramClient(unittest.TestCase):
    """Test suite for TelegramClient and keyboard structures."""

    def test_inline_keyboard_button_helpers(self) -> None:
        from scripts.ops.telegram_ops_bot.telegram import (
            InlineKeyboardButton,
            make_inline_keyboard,
        )

        btn1 = InlineKeyboardButton(text="Refresh", callback_data="refresh:status")
        self.assertEqual(btn1.to_dict(), {"text": "Refresh", "callback_data": "refresh:status"})

        btn2 = InlineKeyboardButton(text="Docs", url="https://omniroute.dev")
        self.assertEqual(btn2.to_dict(), {"text": "Docs", "url": "https://omniroute.dev"})

        # Truncate callback_data over 64 bytes
        long_data = "a" * 100
        btn3 = InlineKeyboardButton(text="Long", callback_data=long_data)
        self.assertEqual(len(btn3.to_dict()["callback_data"].encode("utf-8")), 64)

        markup = make_inline_keyboard([
            [("Refresh", "refresh"), ("System", "system")],
            [btn2],
        ])
        self.assertIn("inline_keyboard", markup)
        self.assertEqual(len(markup["inline_keyboard"]), 2)
        self.assertEqual(markup["inline_keyboard"][0][0]["callback_data"], "refresh")

    @unittest.mock.patch("urllib.request.urlopen")
    def test_telegram_client_api_methods(self, mock_urlopen: unittest.mock.MagicMock) -> None:
        import json
        from scripts.ops.telegram_ops_bot.telegram import TelegramClient

        client = TelegramClient(bot_token="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234")

        # Mock getMe response
        mock_resp = unittest.mock.MagicMock()
        mock_resp.read.return_value = json.dumps({
            "ok": True,
            "result": {"id": 123456, "is_bot": True, "username": "ops_bot"},
        }).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        me = client.get_me()
        self.assertEqual(me["username"], "ops_bot")

        # Mock sendMessage response
        mock_resp.read.return_value = json.dumps({
            "ok": True,
            "result": {"message_id": 999, "text": "Hello"},
        }).encode("utf-8")

        sent = client.send_message(chat_id=1234, text="Hello")
        self.assertEqual(sent["message_id"], 999)

        # Mock editMessageText response
        mock_resp.read.return_value = json.dumps({
            "ok": True,
            "result": {"message_id": 999, "text": "Updated"},
        }).encode("utf-8")

        edited = client.edit_message_text(chat_id=1234, message_id=999, text="Updated")
        self.assertEqual(edited["text"], "Updated")

        # Mock answerCallbackQuery response
        mock_resp.read.return_value = json.dumps({
            "ok": True,
            "result": True,
        }).encode("utf-8")

        ans = client.answer_callback_query(callback_query_id="cb_1")
        self.assertTrue(ans)

        # Mock getUpdates response
        mock_resp.read.return_value = json.dumps({
            "ok": True,
            "result": [{"update_id": 100, "message": {"text": "/status"}}],
        }).encode("utf-8")

        updates = client.get_updates(offset=100, timeout=10)
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["update_id"], 100)


if __name__ == "__main__":
    unittest.main()
