"""Unit tests for SQLite state management, audit logging, pending action replay guard, and lockout."""

import os
import tempfile
import time
import unittest

from scripts.ops.telegram_ops_bot.state import StateManager


class TestState(unittest.TestCase):
    """Test suite for StateManager SQLite operations."""

    def setUp(self) -> None:
        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.state = StateManager(db_path=self.temp_db.name)

    def tearDown(self) -> None:
        if os.path.exists(self.temp_db.name):
            try:
                os.remove(self.temp_db.name)
            except OSError:
                pass

    def test_offset_management(self) -> None:
        # Default offset
        self.assertEqual(self.state.get_offset(), 0)

        # Set and get
        self.state.set_offset(100500)
        self.assertEqual(self.state.get_offset(), 100500)

        # Overwrite with higher offset
        self.state.set_offset(100501)
        self.assertEqual(self.state.get_offset(), 100501)

    def test_audit_logging(self) -> None:
        log_id1 = self.state.log_audit(
            user_id=123,
            chat_id=456,
            command="/status",
            args="",
            status="SUCCESS",
            details="Overview requested",
        )
        self.assertGreater(log_id1, 0)

        log_id2 = self.state.log_audit(
            user_id=123,
            chat_id=456,
            command="/containers",
            args="--all",
            status="DENIED",
            details="Unauthorized user",
        )
        self.assertGreater(log_id2, log_id1)

        recent = self.state.get_recent_audit_logs(limit=10)
        self.assertEqual(len(recent), 2)
        # Most recent first
        self.assertEqual(recent[0]["command"], "/containers")
        self.assertEqual(recent[0]["status"], "DENIED")
        self.assertEqual(recent[1]["command"], "/status")

    def test_pending_action_lifecycle_and_replay_guard(self) -> None:
        user_id = 999
        payload = {"action": "restart_service", "target": "omniroute"}
        nonce = self.state.create_pending_action(
            user_id=user_id,
            action_type="restart",
            payload=payload,
            ttl_seconds=60,
        )
        self.assertTrue(bool(nonce))

        # Check pending action
        action_data = self.state.get_pending_action(nonce)
        self.assertIsNotNone(action_data)
        self.assertEqual(action_data["user_id"], user_id)
        self.assertEqual(action_data["action_type"], "restart")
        self.assertEqual(action_data["payload"]["target"], "omniroute")
        self.assertFalse(action_data["is_expired"])
        self.assertEqual(action_data["consumed"], 0)

        # Unauthorized user attempt to consume
        success, msg, consumed_data = self.state.consume_pending_action(nonce, user_id=888)
        self.assertFalse(success)
        self.assertIn("User ID mismatch", msg)
        self.assertIsNone(consumed_data)

        # Successful consume
        success, msg, consumed_data = self.state.consume_pending_action(nonce, user_id=user_id)
        self.assertTrue(success)
        self.assertIn("confirmed successfully", msg)
        self.assertIsNotNone(consumed_data)
        self.assertEqual(consumed_data["payload"]["action"], "restart_service")

        # Replay attempt (second consume must fail)
        success2, msg2, _ = self.state.consume_pending_action(nonce, user_id=user_id)
        self.assertFalse(success2)
        self.assertIn("already been executed", msg2)

    def test_pending_action_ttl_expiration(self) -> None:
        user_id = 999
        nonce = self.state.create_pending_action(
            user_id=user_id,
            action_type="deploy",
            payload={"tag": "v1.0.0"},
            ttl_seconds=10,
        )

        # Check in future beyond TTL
        future_time = time.time() + 20
        action_data = self.state.get_pending_action(nonce, current_time=future_time)
        self.assertTrue(action_data["is_expired"])

        success, msg, _ = self.state.consume_pending_action(nonce, user_id=user_id, current_time=future_time)
        self.assertFalse(success)
        self.assertIn("expired", msg)

    def test_auth_attempts_and_lockout(self) -> None:
        user_id = 777
        is_locked, remaining = self.state.is_user_locked_out(user_id)
        self.assertFalse(is_locked)
        self.assertEqual(remaining, 0)

        # First failure
        is_locked, count, remaining = self.state.record_pin_failure(
            user_id=user_id, max_attempts=3, lockout_duration_seconds=300
        )
        self.assertFalse(is_locked)
        self.assertEqual(count, 1)

        # Second failure
        is_locked, count, remaining = self.state.record_pin_failure(
            user_id=user_id, max_attempts=3, lockout_duration_seconds=300
        )
        self.assertFalse(is_locked)
        self.assertEqual(count, 2)

        # Third failure -> Triggers lockout
        is_locked, count, remaining = self.state.record_pin_failure(
            user_id=user_id, max_attempts=3, lockout_duration_seconds=300
        )
        self.assertTrue(is_locked)
        self.assertEqual(count, 3)
        self.assertGreater(remaining, 0)

        # User is now locked out
        is_locked_check, rem_check = self.state.is_user_locked_out(user_id)
        self.assertTrue(is_locked_check)
        self.assertGreater(rem_check, 0)

        # Success clears lockout and reset counters
        self.state.record_pin_success(user_id)
        is_locked_after, rem_after = self.state.is_user_locked_out(user_id)
        self.assertFalse(is_locked_after)
        self.assertEqual(rem_after, 0)

    def test_alert_state_persistence(self) -> None:
        alert_key = "cpu_threshold_high"
        self.assertIsNone(self.state.get_alert_state(alert_key))

        self.state.set_alert_state(
            alert_key=alert_key,
            state="FIRING",
            metadata={"cpu_pct": 94.5, "host": "srv-prod-01"},
        )

        state_data = self.state.get_alert_state(alert_key)
        self.assertIsNotNone(state_data)
        self.assertEqual(state_data["state"], "FIRING")
        self.assertEqual(state_data["metadata"]["cpu_pct"], 94.5)

        # Update to RESOLVED
        self.state.set_alert_state(alert_key=alert_key, state="RESOLVED")
        updated_data = self.state.get_alert_state(alert_key)
        self.assertEqual(updated_data["state"], "RESOLVED")


if __name__ == "__main__":
    unittest.main()
