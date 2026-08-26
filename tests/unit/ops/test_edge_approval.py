"""Unit tests for Telegram Ops Bot Edge Approval Gateway integration."""

import json
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from scripts.ops.telegram_ops_bot.commands import CommandDispatcher
from scripts.ops.telegram_ops_bot.config import BotConfig
from scripts.ops.telegram_ops_bot.edge_approval import (
    EdgeControlAuthError,
    EdgeControlClient,
    EdgeControlError,
    EdgeControlNetworkError,
)
from scripts.ops.telegram_ops_bot.metrics import MetricsCollector
from scripts.ops.telegram_ops_bot.security import hash_pin
from scripts.ops.telegram_ops_bot.state import StateManager
from scripts.ops.telegram_ops_bot.telegram import TelegramClient


class TestEdgeControlClient(unittest.TestCase):
    """Test suite for EdgeControlClient."""

    def setUp(self) -> None:
        self.client = EdgeControlClient(
            edge_public_url="https://edge.example.com",
            edge_control_secret="test-edge-control-secret-123456",
            timeout=5.0,
        )

    def test_sign_payload(self) -> None:
        raw_body = '{"clientId":"test1234","action":"allow"}'
        timestamp_str, nonce, signature = self.client._sign_payload(raw_body)

        self.assertTrue(timestamp_str.isdigit())
        self.assertEqual(len(nonce), 32)
        self.assertEqual(len(signature), 64)

    @patch("urllib.request.urlopen")
    def test_send_decision_success(self, mock_urlopen: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.read.return_value = b'{"success":true,"status":"APPROVED","approvedUntil":1787654321000}'
        mock_urlopen.return_value.__enter__.return_value = mock_response

        res = self.client.send_decision(
            client_id="client_abc123",
            action="allow",
            duration_seconds=86400,
            telegram_message_id=999,
        )

        self.assertTrue(res.get("success"))
        self.assertEqual(res.get("status"), "APPROVED")
        mock_urlopen.assert_called_once()
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_header("Content-type"), "application/json")
        self.assertIsNotNone(req.get_header("X-edge-timestamp"))
        self.assertIsNotNone(req.get_header("X-edge-nonce"))
        self.assertIsNotNone(req.get_header("X-edge-signature"))

    @patch("urllib.request.urlopen")
    def test_reset_access(self, mock_urlopen: MagicMock) -> None:
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.read.return_value = b'{"success":true,"status":"UNKNOWN"}'
        mock_urlopen.return_value.__enter__.return_value = mock_response

        res = self.client.reset_access("client_abc123")
        self.assertTrue(res.get("success"))
        self.assertEqual(res.get("status"), "UNKNOWN")

    @patch("urllib.request.urlopen")
    def test_auth_error_on_401(self, mock_urlopen: MagicMock) -> None:
        import urllib.error
        mock_urlopen.side_effect = urllib.error.HTTPError(
            url="https://edge.example.com",
            code=401,
            msg="Unauthorized",
            hdrs={},
            fp=None,
        )

        with self.assertRaises(EdgeControlAuthError):
            self.client.send_decision("client_abc123", "allow")


class TestCommandDispatcherEdge(unittest.TestCase):
    """Test suite for CommandDispatcher edge approval handling."""

    def setUp(self) -> None:
        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.state = StateManager(db_path=self.temp_db.name)
        pin_hash, pin_salt = hash_pin("123456")

        self.config = BotConfig(
            bot_token="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234",
            allowed_user_ids={1001},
            allowed_chat_ids={2001},
            pin_hash=pin_hash,
            pin_salt=pin_salt,
            db_path=self.temp_db.name,
            require_private_chat=True,
            edge_public_url="https://edge.example.com",
            edge_control_secret="test-secret",
        )

        self.mock_metrics = MagicMock(spec=MetricsCollector)
        self.mock_telegram = MagicMock(spec=TelegramClient)
        self.mock_edge_client = MagicMock(spec=EdgeControlClient)
        self.mock_edge_client.edge_public_url = "https://edge.example.com"

        self.dispatcher = CommandDispatcher(
            config=self.config,
            state=self.state,
            metrics=self.mock_metrics,
            telegram=self.mock_telegram,
            edge_client=self.mock_edge_client,
        )

    def test_access_command_overview(self) -> None:
        msg = {
            "message_id": 1,
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/access",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_telegram.send_message.assert_called_once()
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("Cloudflare Edge Approval Gateway", kwargs["text"])

    def test_access_command_reset(self) -> None:
        self.mock_edge_client.reset_access.return_value = {"success": True, "status": "UNKNOWN"}
        msg = {
            "message_id": 1,
            "from": {"id": 1001},
            "chat": {"id": 2001, "type": "private"},
            "text": "/access reset client_test_123",
        }
        self.dispatcher.dispatch_message(msg)

        self.mock_edge_client.reset_access.assert_called_once_with("client_test_123")
        _, kwargs = self.mock_telegram.send_message.call_args
        self.assertIn("Edge Access Reset", kwargs["text"])

    def test_callback_access_allow(self) -> None:
        self.mock_edge_client.send_decision.return_value = {
            "success": True,
            "status": "APPROVED",
            "approvedUntil": 1787654321000,
        }

        callback = {
            "id": "cb_access_1",
            "from": {"id": 1001},
            "message": {
                "message_id": 777,
                "chat": {"id": 2001, "type": "private"},
            },
            "data": "access:allow:client_123:1",
        }

        self.dispatcher.dispatch_callback_query(callback)

        self.mock_edge_client.send_decision.assert_called_once_with(
            "client_123",
            action="allow",
            duration_seconds=86400,
            telegram_message_id=777,
            actor="1001",
        )
        self.mock_telegram.answer_callback_query.assert_called_once_with(
            "cb_access_1",
            text="✅ Approved for 24h",
        )
        self.mock_telegram.edit_message_text.assert_called_once()
        _, kwargs = self.mock_telegram.edit_message_text.call_args
        self.assertIn("APPROVED", kwargs["text"])

    def test_callback_access_deny(self) -> None:
        self.mock_edge_client.send_decision.return_value = {
            "success": True,
            "status": "DENIED",
        }

        callback = {
            "id": "cb_access_2",
            "from": {"id": 1001},
            "message": {
                "message_id": 778,
                "chat": {"id": 2001, "type": "private"},
            },
            "data": "access:deny:client_456:1",
        }

        self.dispatcher.dispatch_callback_query(callback)

        self.mock_edge_client.send_decision.assert_called_once_with(
            "client_456",
            action="deny",
            telegram_message_id=778,
            actor="1001",
        )
        self.mock_telegram.answer_callback_query.assert_called_once_with(
            "cb_access_2",
            text="❌ Access Denied",
        )
        self.mock_telegram.edit_message_text.assert_called_once()
        _, kwargs = self.mock_telegram.edit_message_text.call_args
        self.assertIn("DENIED", kwargs["text"])

    def test_callback_unauthorized_user_blocked(self) -> None:
        callback = {
            "id": "cb_access_unauth",
            "from": {"id": 9999},  # Unauthorized user ID
            "message": {
                "message_id": 779,
                "chat": {"id": 2001, "type": "private"},
            },
            "data": "access:allow:client_789:1",
        }

        self.dispatcher.dispatch_callback_query(callback)

        self.mock_edge_client.send_decision.assert_not_called()
        self.mock_telegram.answer_callback_query.assert_called_once()
        _, kwargs = self.mock_telegram.answer_callback_query.call_args
        self.assertTrue(kwargs.get("show_alert"))
        self.mock_telegram.edit_message_text.assert_not_called()


if __name__ == "__main__":
    unittest.main()
