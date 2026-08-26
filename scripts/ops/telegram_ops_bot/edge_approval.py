"""Edge Approval Gateway client for Telegram Ops Bot.

Handles HMAC-SHA256 request signing, decision submission (allow, deny, reset),
status queries, and error recovery for the Cloudflare Worker edge approval plane.
Python 3.9+ standard library only.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger("telegram_ops_bot.edge")


class EdgeControlError(Exception):
    """Base exception for Edge Approval Control errors."""


class EdgeControlAuthError(EdgeControlError):
    """Authentication or signature failure communicating with Edge."""


class EdgeControlNetworkError(EdgeControlError):
    """Network failure or timeout communicating with Edge."""


class EdgeControlClient:
    """HTTP client communicating with Cloudflare Worker signed edge-control endpoint."""

    def __init__(
        self,
        edge_public_url: str,
        edge_control_secret: str,
        timeout: float = 10.0,
    ) -> None:
        self.edge_public_url = edge_public_url.rstrip("/")
        self.edge_control_secret = edge_control_secret
        self.timeout = timeout

    def _sign_payload(self, raw_body: str) -> Tuple[str, str, str]:
        """Generate timestamp, nonce, and HMAC-SHA256 signature for control requests.

        Returns:
            Tuple of (timestamp_str, nonce, signature_hex)
        """
        timestamp_str = str(int(time.time()))
        nonce = secrets.token_hex(16)
        string_to_sign = f"{timestamp_str}.{nonce}.{raw_body}"

        sig = hmac.new(
            self.edge_control_secret.encode("utf-8"),
            string_to_sign.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        return timestamp_str, nonce, sig

    def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Perform signed POST request to the Edge Gateway."""
        raw_body = json.dumps(payload, separators=(",", ":"))
        timestamp_str, nonce, signature = self._sign_payload(raw_body)

        url = f"{self.edge_public_url}{path}"
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "OmniRoute-OpsBot/1.0",
            "X-Edge-Timestamp": timestamp_str,
            "X-Edge-Nonce": nonce,
            "X-Edge-Signature": signature,
        }

        req = urllib.request.Request(
            url,
            data=raw_body.encode("utf-8"),
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                status = resp.status
                body_str = resp.read().decode("utf-8")
                try:
                    data = json.loads(body_str)
                    return data if isinstance(data, dict) else {"raw": body_str}
                except json.JSONDecodeError:
                    return {"raw": body_str, "status": status}
        except urllib.error.HTTPError as http_err:
            err_body = ""
            try:
                err_body = http_err.read().decode("utf-8")
                parsed = json.loads(err_body)
                desc = parsed.get("error", err_body)
            except Exception:
                desc = str(http_err)

            if http_err.code in (401, 403):
                raise EdgeControlAuthError(
                    f"Edge Control Unauthorized ({http_err.code}): {desc}"
                ) from http_err
            raise EdgeControlError(f"Edge Control HTTP {http_err.code}: {desc}") from http_err
        except (urllib.error.URLError, TimeoutError, OSError) as net_err:
            raise EdgeControlNetworkError(
                f"Network error communicating with Edge Control: {net_err}"
            ) from net_err

    def send_decision(
        self,
        client_id: str,
        action: str,
        duration_seconds: int = 86400,
        telegram_message_id: Optional[int] = None,
        actor: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Submit operator decision (allow, deny, reset) to the Edge Gateway.

        Args:
            client_id: SHA256 hex or prefix of the client API key
            action: 'allow', 'deny', or 'reset'
            duration_seconds: approval duration (default 24h = 86400s)
            telegram_message_id: Telegram message ID of the alert card
            actor: Operator user identification

        Returns:
            Dict containing edge response (success, status, approvedUntil, etc.)
        """
        payload: Dict[str, Any] = {
            "clientId": client_id,
            "action": action,
            "durationSeconds": duration_seconds,
        }
        if telegram_message_id is not None:
            payload["telegramMessageId"] = telegram_message_id
        if actor:
            payload["actor"] = actor

        return self._post("/__edge-control/decision", payload)

    def reset_access(self, client_id: str, actor: Optional[str] = None) -> Dict[str, Any]:
        """Reset a client approval record back to UNKNOWN state."""
        return self.send_decision(client_id=client_id, action="reset", actor=actor)
