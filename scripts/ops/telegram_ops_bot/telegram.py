"""Robust Telegram Bot API client using standard library urllib.request.

Supports long polling, retries with exponential backoff, rate limiting,
callback query handling, and inline keyboard generation.
"""

import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple, Union


logger = logging.getLogger("telegram_ops_bot.telegram")


class TelegramError(Exception):
    """Base exception for Telegram Bot API failures."""


class TelegramNetworkError(TelegramError):
    """Network connection or timeout error."""


class TelegramAPIError(TelegramError):
    """Error returned by Telegram API."""

    def __init__(
        self,
        message: str,
        status_code: int = 0,
        error_code: Optional[int] = None,
        description: Optional[str] = None,
        parameters: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code or status_code
        self.description = description or message
        self.parameters = parameters or {}

    @property
    def retry_after(self) -> Optional[int]:
        if self.parameters and "retry_after" in self.parameters:
            try:
                return int(self.parameters["retry_after"])
            except (ValueError, TypeError):
                return None
        return None


class TelegramRateLimitError(TelegramAPIError):
    """Telegram 429 Too Many Requests error."""


class TelegramUnauthorizedError(TelegramAPIError):
    """Telegram 401 Unauthorized error (e.g. invalid bot token)."""


class InlineKeyboardButton:
    """Represents an inline keyboard button."""

    def __init__(
        self,
        text: str,
        callback_data: Optional[str] = None,
        url: Optional[str] = None,
    ) -> None:
        self.text = text
        self.callback_data = callback_data
        self.url = url

    def to_dict(self) -> Dict[str, str]:
        d: Dict[str, str] = {"text": self.text}
        if self.callback_data is not None:
            # Telegram callback_data limit is 64 bytes
            data_bytes = self.callback_data.encode("utf-8")
            if len(data_bytes) > 64:
                self.callback_data = data_bytes[:64].decode("utf-8", errors="ignore")
            d["callback_data"] = self.callback_data
        elif self.url is not None:
            d["url"] = self.url
        return d


def make_inline_keyboard(rows: List[List[Union[InlineKeyboardButton, Tuple[str, str]]]]) -> Dict[str, Any]:
    """Helper to build an inline keyboard markup dict from nested lists of buttons or (text, callback_data) tuples."""
    keyboard: List[List[Dict[str, str]]] = []
    for row in rows:
        button_row: List[Dict[str, str]] = []
        for btn in row:
            if isinstance(btn, InlineKeyboardButton):
                button_row.append(btn.to_dict())
            elif isinstance(btn, tuple) and len(btn) == 2:
                btn_obj = InlineKeyboardButton(text=btn[0], callback_data=btn[1])
                button_row.append(btn_obj.to_dict())
        if button_row:
            keyboard.append(button_row)
    return {"inline_keyboard": keyboard}


class TelegramClient:
    """HTTP client for Telegram Bot API using urllib.request."""

    BASE_URL = "https://api.telegram.org/bot"

    def __init__(
        self,
        bot_token: str,
        max_retries: int = 3,
        retry_backoff: float = 1.5,
        rate_limit_per_minute: int = 30,
    ) -> None:
        self.bot_token = bot_token
        self.api_url = f"{self.BASE_URL}{bot_token}/"
        self.max_retries = max_retries
        self.retry_backoff = retry_backoff
        self.rate_limit_per_minute = rate_limit_per_minute
        self._last_request_times: List[float] = []
        self._rate_lock = threading.Lock()

    def _wait_for_rate_limit(self) -> None:
        """Enforce basic sliding-window rate limiting.

        Alerting runs on its own thread and can send while the webhook worker is
        also sending, so the window bookkeeping is locked. The sleep itself is
        left outside the lock: holding it there would serialise senders for the
        full backoff instead of just the accounting.
        """
        if self.rate_limit_per_minute <= 0:
            return
        with self._rate_lock:
            now = time.time()
            # Discard records older than 60s
            self._last_request_times = [t for t in self._last_request_times if now - t < 60.0]
            sleep_duration = 0.0
            if len(self._last_request_times) >= self.rate_limit_per_minute:
                sleep_duration = 60.0 - (now - self._last_request_times[0]) + 0.1
            self._last_request_times.append(time.time())
        if sleep_duration > 0:
            time.sleep(min(sleep_duration, 5.0))

    def _request(
        self,
        method: str,
        payload: Optional[Dict[str, Any]] = None,
        timeout: float = 35.0,
    ) -> Dict[str, Any]:
        """Perform an HTTP POST/GET request to Telegram Bot API with retries."""
        url = f"{self.api_url}{method}"
        data = None
        headers = {"User-Agent": "OmniRoute-TelegramOpsBot/1.0"}

        if payload is not None:
            # Clean None values from payload
            clean_payload = {k: v for k, v in payload.items() if v is not None}
            data = json.dumps(clean_payload).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"

        attempt = 0
        backoff = self.retry_backoff

        while True:
            attempt += 1
            self._wait_for_rate_limit()

            req = urllib.request.Request(url, data=data, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    res_body = response.read().decode("utf-8")
                    result = json.loads(res_body)
                    if result.get("ok"):
                        return result.get("result", {})
                    # API returned ok: false in 200 OK
                    desc = result.get("description", "Unknown Telegram error")
                    err_code = result.get("error_code", response.status)
                    raise TelegramAPIError(desc, status_code=response.status, error_code=err_code)

            except urllib.error.HTTPError as http_err:
                err_body = ""
                try:
                    err_body = http_err.read().decode("utf-8")
                    parsed = json.loads(err_body)
                    desc = parsed.get("description", str(http_err))
                    err_code = parsed.get("error_code", http_err.code)
                    params = parsed.get("parameters", {})
                except Exception:
                    desc = str(http_err)
                    err_code = http_err.code
                    params = {}

                if http_err.code == 401:
                    raise TelegramUnauthorizedError(
                        f"Telegram API 401 Unauthorized: {desc}",
                        status_code=401,
                        error_code=err_code,
                        description=desc,
                    )

                if http_err.code == 429:
                    retry_sec = params.get("retry_after", backoff)
                    logger.warning("Telegram rate limit encountered. Backing off for %s seconds.", retry_sec)
                    if attempt < self.max_retries:
                        time.sleep(float(retry_sec) + 0.5)
                        continue
                    raise TelegramRateLimitError(
                        f"Rate limited by Telegram API: {desc}",
                        status_code=429,
                        error_code=err_code,
                        description=desc,
                        parameters=params,
                    )

                # Retry on 5xx server errors
                if 500 <= http_err.code < 600 and attempt < self.max_retries:
                    logger.warning("Telegram 5xx error (%s). Retrying in %.2fs...", http_err.code, backoff)
                    time.sleep(backoff)
                    backoff *= 2
                    continue

                raise TelegramAPIError(
                    f"Telegram HTTP {http_err.code}: {desc}",
                    status_code=http_err.code,
                    error_code=err_code,
                    description=desc,
                    parameters=params,
                )

            except (urllib.error.URLError, TimeoutError, OSError) as net_err:
                if attempt < self.max_retries:
                    logger.warning("Network error (%s). Retrying in %.2fs...", net_err, backoff)
                    time.sleep(backoff)
                    backoff *= 2
                    continue
                raise TelegramNetworkError(f"Network error communicating with Telegram API: {net_err}") from net_err

    # --- API Methods ---

    def get_me(self) -> Dict[str, Any]:
        """Test authentication and get bot account information."""
        return self._request("getMe", timeout=10.0)

    def delete_webhook(self, drop_pending_updates: bool = False) -> bool:
        """Ensure this private bot uses long polling rather than a public webhook."""
        result = self._request(
            "deleteWebhook",
            payload={"drop_pending_updates": drop_pending_updates},
            timeout=10.0,
        )
        return bool(result)

    def set_webhook(
        self,
        url: str,
        secret_token: str,
        allowed_updates: Optional[List[str]] = None,
        max_connections: int = 10,
        drop_pending_updates: bool = False,
    ) -> bool:
        """Register the public webhook endpoint Telegram should POST updates to.

        `secret_token` is echoed back on every delivery in the
        X-Telegram-Bot-Api-Secret-Token header and is the only thing that proves
        a request really came from Telegram, so it is required here rather than
        optional.
        """
        result = self._request(
            "setWebhook",
            payload={
                "url": url,
                "secret_token": secret_token,
                "allowed_updates": allowed_updates or ["message", "callback_query"],
                "max_connections": max_connections,
                "drop_pending_updates": drop_pending_updates,
            },
            timeout=15.0,
        )
        return bool(result)

    def get_webhook_info(self) -> Dict[str, Any]:
        """Return Telegram's view of the current webhook (url, pending count, last error)."""
        result = self._request("getWebhookInfo", timeout=10.0)
        return result if isinstance(result, dict) else {}

    def get_updates(
        self,
        offset: Optional[int] = None,
        limit: int = 100,
        timeout: int = 30,
    ) -> List[Dict[str, Any]]:
        """Fetch incoming updates with long-polling."""
        payload: Dict[str, Any] = {
            "limit": limit,
            "timeout": timeout,
            "allowed_updates": ["message", "callback_query"],
        }
        if offset is not None:
            payload["offset"] = offset
        # Request timeout must be slightly higher than long poll timeout
        http_timeout = float(timeout) + 10.0
        res = self._request("getUpdates", payload=payload, timeout=http_timeout)
        if isinstance(res, list):
            return res
        return []

    def send_message(
        self,
        chat_id: int,
        text: str,
        parse_mode: Optional[str] = "HTML",
        reply_markup: Optional[Dict[str, Any]] = None,
        disable_web_page_preview: bool = True,
    ) -> Dict[str, Any]:
        """Send text message."""
        payload: Dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": parse_mode,
            "disable_web_page_preview": disable_web_page_preview,
        }
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        return self._request("sendMessage", payload=payload, timeout=15.0)

    def edit_message_text(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        parse_mode: Optional[str] = "HTML",
        reply_markup: Optional[Dict[str, Any]] = None,
        disable_web_page_preview: bool = True,
    ) -> Dict[str, Any]:
        """Edit an existing message text."""
        payload: Dict[str, Any] = {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "parse_mode": parse_mode,
            "disable_web_page_preview": disable_web_page_preview,
        }
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        return self._request("editMessageText", payload=payload, timeout=15.0)

    def answer_callback_query(
        self,
        callback_query_id: str,
        text: Optional[str] = None,
        show_alert: bool = False,
    ) -> Dict[str, Any]:
        """Acknowledge a callback button press."""
        payload: Dict[str, Any] = {
            "callback_query_id": callback_query_id,
            "show_alert": show_alert,
        }
        if text:
            payload["text"] = text
        return self._request("answerCallbackQuery", payload=payload, timeout=10.0)

    def delete_message(self, chat_id: int, message_id: int) -> bool:
        """Delete a message."""
        try:
            res = self._request("deleteMessage", payload={"chat_id": chat_id, "message_id": message_id}, timeout=10.0)
            return bool(res)
        except TelegramAPIError:
            return False
