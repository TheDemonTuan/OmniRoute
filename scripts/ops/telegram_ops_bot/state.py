"""State and database persistence module for Telegram Ops Bot.

Manages SQLite storage for:
- Telegram update offset tracking
- Audit logs of commands and actions
- Pending confirmation actions with nonce TTL and replay guards
- Failed authentication attempt counters and lockout state
- System alerts and notification state
Uses Python standard library sqlite3 only.
"""

import json
import os
import sqlite3
import time
from typing import Any, Dict, List, Optional, Tuple

from .alerts import StateManagerAlertPersistenceAdapter
from .security import generate_nonce


class StateManager:
    """SQLite-backed state and audit repository."""

    def __init__(self, db_path: str = "data/telegram_ops_bot.sqlite3") -> None:
        self.db_path = db_path
        self._ensure_db_dir()
        self.init_db()

    def _ensure_db_dir(self) -> None:
        """Create parent directory if it does not exist."""
        if self.db_path and self.db_path != ":memory:":
            dirname = os.path.dirname(self.db_path)
            if dirname:
                os.makedirs(dirname, exist_ok=True)

    def _get_connection(self) -> sqlite3.Connection:
        """Create and configure a SQLite connection."""
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        if self.db_path != ":memory:":
            conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=5000;")
        return conn

    def init_db(self) -> None:
        """Initialize database schema tables idempotently."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS bot_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL NOT NULL,
                    user_id INTEGER NOT NULL,
                    chat_id INTEGER NOT NULL,
                    command TEXT NOT NULL,
                    args TEXT,
                    status TEXT NOT NULL,
                    details TEXT
                );
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_user_ts ON audit_log(user_id, timestamp);")

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS pending_actions (
                    nonce TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    action_type TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    consumed INTEGER DEFAULT 0,
                    consumed_at REAL
                );
            """)
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_actions(user_id);")

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS auth_attempts (
                    user_id INTEGER PRIMARY KEY,
                    failed_count INTEGER DEFAULT 0,
                    locked_until REAL DEFAULT 0,
                    last_attempt REAL NOT NULL
                );
            """)

            cursor.execute("""
                CREATE TABLE IF NOT EXISTS alert_state (
                    alert_key TEXT PRIMARY KEY,
                    state TEXT NOT NULL,
                    last_notified REAL NOT NULL,
                    metadata TEXT
                );
            """)
            conn.commit()

    # --- Offset management ---

    def get_offset(self, default: int = 0) -> int:
        """Get the last processed Telegram update offset."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT value FROM bot_state WHERE key = 'last_update_offset'")
            row = cursor.fetchone()
            if row:
                try:
                    return int(row["value"])
                except ValueError:
                    return default
            return default

    def set_offset(self, offset: int) -> None:
        """Update the last processed Telegram update offset."""
        now = time.time()
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO bot_state (key, value, updated_at)
                VALUES ('last_update_offset', ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (str(offset), now),
            )
            conn.commit()

    # --- Audit logging ---

    def log_audit(
        self,
        user_id: int,
        chat_id: int,
        command: str,
        args: str = "",
        status: str = "SUCCESS",
        details: str = "",
    ) -> int:
        """Record an operation in the audit log. Returns log ID."""
        now = time.time()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO audit_log (timestamp, user_id, chat_id, command, args, status, details)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (now, user_id, chat_id, command, args, status, details),
            )
            conn.commit()
            return cursor.lastrowid or 0

    def get_recent_audit_logs(self, limit: int = 20) -> List[Dict[str, Any]]:
        """Retrieve recent audit log entries."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, timestamp, user_id, chat_id, command, args, status, details
                FROM audit_log
                ORDER BY timestamp DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    # --- Pending actions with nonce & TTL replay guard ---

    def create_pending_action(
        self,
        user_id: int,
        action_type: str,
        payload: Dict[str, Any],
        ttl_seconds: int = 300,
        nonce: Optional[str] = None,
    ) -> str:
        """Create a new pending action with a one-time cryptographic nonce and TTL."""
        if not nonce:
            nonce = generate_nonce(16)
        now = time.time()
        expires_at = now + ttl_seconds
        payload_json = json.dumps(payload)

        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO pending_actions (nonce, user_id, action_type, payload, created_at, expires_at, consumed)
                VALUES (?, ?, ?, ?, ?, ?, 0)
                """,
                (nonce, user_id, action_type, payload_json, now, expires_at),
            )
            conn.commit()
        return nonce

    def get_pending_action(self, nonce: str, current_time: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """Fetch pending action details by nonce without consuming it."""
        now = current_time if current_time is not None else time.time()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT nonce, user_id, action_type, payload, created_at, expires_at, consumed, consumed_at
                FROM pending_actions
                WHERE nonce = ?
                """,
                (nonce,),
            )
            row = cursor.fetchone()
            if not row:
                return None
            data = dict(row)
            try:
                data["payload"] = json.loads(data["payload"])
            except Exception:
                pass
            data["is_expired"] = now > data["expires_at"]
            return data

    def consume_pending_action(
        self,
        nonce: str,
        user_id: int,
        current_time: Optional[float] = None,
    ) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        """Atomically validate and consume a one-time pending action.

        Returns:
            Tuple[bool, str, Optional[Dict]]: (success, message, action_dict)
        """
        now = current_time if current_time is not None else time.time()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT nonce, user_id, action_type, payload, created_at, expires_at, consumed
                FROM pending_actions
                WHERE nonce = ?
                """,
                (nonce,),
            )
            row = cursor.fetchone()
            if not row:
                return False, "Action not found or invalid token.", None

            action = dict(row)
            if action["consumed"] != 0:
                return False, "This action has already been executed.", None

            if action["user_id"] != user_id:
                return False, "Unauthorized: User ID mismatch for this action.", None

            if now > action["expires_at"]:
                return False, "This confirmation has expired.", None

            # Mark consumed atomically
            cursor.execute(
                """
                UPDATE pending_actions
                SET consumed = 1, consumed_at = ?
                WHERE nonce = ? AND consumed = 0
                """,
                (now, nonce),
            )
            if cursor.rowcount == 0:
                return False, "Concurrent execution conflict: already consumed.", None

            conn.commit()

            try:
                action["payload"] = json.loads(action["payload"])
            except Exception:
                pass

            return True, "Action confirmed successfully.", action

    # --- Authentication attempts & lockout ---

    def is_user_locked_out(
        self,
        user_id: int,
        current_time: Optional[float] = None,
    ) -> Tuple[bool, int]:
        """Check if a user is currently locked out due to excessive failed PIN attempts.

        Returns:
            Tuple[bool, int]: (is_locked_out, remaining_lockout_seconds)
        """
        now = current_time if current_time is not None else time.time()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT failed_count, locked_until
                FROM auth_attempts
                WHERE user_id = ?
                """,
                (user_id,),
            )
            row = cursor.fetchone()
            if not row:
                return False, 0

            locked_until = row["locked_until"]
            if locked_until and locked_until > now:
                remaining = int(locked_until - now) + 1
                return True, remaining

            return False, 0

    def record_pin_failure(
        self,
        user_id: int,
        max_attempts: int = 3,
        lockout_duration_seconds: int = 900,
        current_time: Optional[float] = None,
    ) -> Tuple[bool, int, int]:
        """Record a failed PIN attempt. Triggers lockout if max_attempts is reached.

        Returns:
            Tuple[bool, int, int]: (is_now_locked, total_failed_attempts, remaining_lockout_seconds)
        """
        now = current_time if current_time is not None else time.time()
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT failed_count, locked_until FROM auth_attempts WHERE user_id = ?",
                (user_id,),
            )
            row = cursor.fetchone()
            if not row:
                failed_count = 1
                locked_until = 0.0
            else:
                current_locked_until = row["locked_until"]
                if current_locked_until > now:
                    # Still locked
                    remaining = int(current_locked_until - now) + 1
                    return True, row["failed_count"], remaining
                elif current_locked_until != 0 and current_locked_until <= now:
                    # Previous lockout expired, reset
                    failed_count = 1
                    locked_until = 0.0
                else:
                    failed_count = row["failed_count"] + 1
                    locked_until = 0.0

            is_locked = False
            remaining_seconds = 0
            if failed_count >= max_attempts:
                is_locked = True
                locked_until = now + lockout_duration_seconds
                remaining_seconds = lockout_duration_seconds

            cursor.execute(
                """
                INSERT INTO auth_attempts (user_id, failed_count, locked_until, last_attempt)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    failed_count = excluded.failed_count,
                    locked_until = excluded.locked_until,
                    last_attempt = excluded.last_attempt
                """,
                (user_id, failed_count, locked_until, now),
            )
            conn.commit()
            return is_locked, failed_count, remaining_seconds

    def record_pin_success(self, user_id: int) -> None:
        """Reset failed attempt counters on successful PIN verification."""
        now = time.time()
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO auth_attempts (user_id, failed_count, locked_until, last_attempt)
                VALUES (?, 0, 0, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    failed_count = 0,
                    locked_until = 0,
                    last_attempt = excluded.last_attempt
                """,
                (user_id, now),
            )
            conn.commit()

    # --- Alert State Management ---

    def get_alert_state(self, alert_key: str) -> Optional[Dict[str, Any]]:
        """Retrieve alert state by key."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT alert_key, state, last_notified, metadata FROM alert_state WHERE alert_key = ?",
                (alert_key,),
            )
            row = cursor.fetchone()
            if not row:
                return None
            data = dict(row)
            if data["metadata"]:
                try:
                    data["metadata"] = json.loads(data["metadata"])
                except Exception:
                    pass
            return data

    def set_alert_state(
        self,
        alert_key: str,
        state: str,
        metadata: Optional[Dict[str, Any]] = None,
        timestamp: Optional[float] = None,
    ) -> None:
        """Save or update alert state."""
        now = timestamp if timestamp is not None else time.time()
        meta_json = json.dumps(metadata) if metadata is not None else None
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO alert_state (alert_key, state, last_notified, metadata)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(alert_key) DO UPDATE SET
                    state = excluded.state,
                    last_notified = excluded.last_notified,
                    metadata = excluded.metadata
                """,
                (alert_key, state, now, meta_json),
            )
            conn.commit()

    def delete_alert_state(self, alert_key: str) -> None:
        """Delete alert state for a given alert key."""
        with self._get_connection() as conn:
            conn.execute("DELETE FROM alert_state WHERE alert_key = ?", (alert_key,))
            conn.commit()

    def list_alert_states(self) -> Dict[str, Dict[str, Any]]:
        """List all stored alert states."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT alert_key, state, last_notified, metadata FROM alert_state")
            rows = cursor.fetchall()
            results: Dict[str, Dict[str, Any]] = {}
            for row in rows:
                data = dict(row)
                if data.get("metadata"):
                    try:
                        data["metadata"] = json.loads(data["metadata"])
                    except Exception:
                        pass
                results[data["alert_key"]] = data
            return results

    def clear_all_alert_states(self) -> None:
        """Clear all stored alert states."""
        with self._get_connection() as conn:
            conn.execute("DELETE FROM alert_state")
            conn.commit()

    def get_alert_adapter(self) -> StateManagerAlertPersistenceAdapter:
        """Return an AlertPersistenceAdapter backed by this StateManager."""
        return StateManagerAlertPersistenceAdapter(self)
