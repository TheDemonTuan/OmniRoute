"""Loopback HTTP receiver for Telegram webhook deliveries.

Caddy reverse-proxies the public path to this listener; the socket itself never
leaves 127.0.0.1. Telegram proves who it is with the
X-Telegram-Bot-Api-Secret-Token header, which is the only authentication the
transport offers, so it is checked in constant time before anything else.

Every delivery is acknowledged with 200 as soon as it is queued. Handling runs
on a single worker thread instead of inline, because operations reachable from
an update run for minutes (rollback allows 420s in metrics.perform_operation).
Answering Telegram only after that finished would blow past its delivery timeout
and earn a retry of the same update_id -- meaning a second, unasked-for
execution of a destructive action.
"""

import hmac
import json
import logging
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Optional, Tuple

from .security import redact_sensitive


logger = logging.getLogger("telegram_ops_bot.webhook")

# Pushed into the queue to retire the worker thread.
_STOP = object()


class _WebhookRequestHandler(BaseHTTPRequestHandler):
    """Single-endpoint handler. Everything unexpected gets a terse refusal."""

    protocol_version = "HTTP/1.1"
    server_version = "OmniRouteOpsBot"
    sys_version = ""

    @property
    def _owner(self) -> "WebhookServer":
        return self.server.owner

    def log_message(self, fmt: str, *args: Any) -> None:
        """Route access logs to our logger and never echo a request body.

        The default implementation prints to stderr; more importantly, an update
        body can carry `/confirm NONCE PIN`, so nothing derived from it may
        reach the journal.
        """
        logger.debug("webhook %s", fmt % args)

    def _respond(self, status: int, body: bytes = b"") -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if status != 200:
            # A refusal usually happens before the body was read (an oversized
            # or unauthenticated delivery), and under HTTP/1.1 keep-alive those
            # unread bytes would be parsed as the next request on this socket.
            # Closing is the only way to resynchronise.
            self.close_connection = True
            self.send_header("Connection", "close")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self) -> None:
        self._respond(405)

    def do_HEAD(self) -> None:
        self._respond(405)

    def do_POST(self) -> None:
        owner = self._owner

        # Compare the whole path, secret segment included, so a probe of
        # /tg-ops/ or a guessed prefix is indistinguishable from any other 404.
        req_path = self.path.split("?")[0].rstrip("/")
        owner_path = owner.path.split("?")[0].rstrip("/")
        if req_path != owner_path:
            self._respond(404)
            return

        supplied = self.headers.get("X-Telegram-Bot-Api-Secret-Token") or ""
        if not hmac.compare_digest(supplied, owner.secret_token):
            logger.warning("Rejected webhook delivery with a missing or wrong secret token")
            self._respond(401)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._respond(400)
            return
        if length <= 0:
            self._respond(400)
            return
        if length > owner.max_body_bytes:
            self._respond(413)
            return

        try:
            raw = self.rfile.read(length)
            update = json.loads(raw.decode("utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            # Deliberately no body in the log line: it may contain a PIN.
            logger.warning("Rejected webhook delivery with an unreadable JSON body")
            self._respond(400)
            return

        if not isinstance(update, dict):
            self._respond(400)
            return

        accepted, status = owner.accept(update)
        self._respond(200 if accepted else status)


class _WebhookHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that carries a reference back to its WebhookServer."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: Any, handler: Any, owner: "WebhookServer") -> None:
        self.owner = owner
        super().__init__(address, handler)


class WebhookServer:
    """Loopback listener plus the single worker that drains its queue."""

    def __init__(
        self,
        dispatch: Callable[[Dict[str, Any]], None],
        state: Any,
        path: str,
        secret_token: str,
        port: int = 20129,
        host: str = "127.0.0.1",
        max_body_bytes: int = 1048576,
        queue_size: int = 256,
    ) -> None:
        self.dispatch = dispatch
        self.state = state
        self.path = path
        self.secret_token = secret_token
        self.port = port
        self.host = host
        self.max_body_bytes = max_body_bytes
        self._queue: "queue.Queue[Any]" = queue.Queue(maxsize=queue_size)
        self._worker: Optional[threading.Thread] = None
        self._httpd: Optional[_WebhookHTTPServer] = None

    def accept(self, update: Dict[str, Any]) -> Tuple[bool, int]:
        """Deduplicate and enqueue one update. Returns (accepted, http_status).

        Long polling gets idempotency for free from the offset it sends back to
        Telegram. A webhook has no such handshake -- Telegram simply redelivers
        anything it did not see acknowledged -- so the persisted offset is the
        only thing standing between a retry and a duplicate execution.
        """
        update_id = update.get("update_id")
        if not isinstance(update_id, int) or isinstance(update_id, bool):
            return False, 400

        try:
            offset = self.state.get_offset()
        except Exception as error:
            # State is SQLite; if it cannot be read we must not ack, or the
            # update is lost with no dedup record either way.
            logger.error("Could not read update offset: %s", redact_sensitive(str(error)))
            return False, 503

        if update_id < offset:
            logger.info("Skipping already-processed update %d (offset %d)", update_id, offset)
            return True, 200

        try:
            self._queue.put_nowait(update)
        except queue.Full:
            # 503 rather than a silent drop: Telegram redelivers, and by then the
            # worker has drained. Dropping would lose the command outright.
            logger.warning("Webhook queue is full; asking Telegram to retry update %d", update_id)
            return False, 503

        try:
            self.state.set_offset(update_id + 1)
        except Exception as error:
            logger.error("Could not persist update offset: %s", redact_sensitive(str(error)))

        return True, 200

    def _run_worker(self) -> None:
        while True:
            item = self._queue.get()
            if item is _STOP:
                self._queue.task_done()
                return
            try:
                self.dispatch(item)
            except Exception as error:
                logger.error(
                    "Error handling update %s: %s",
                    item.get("update_id"),
                    redact_sensitive(str(error)),
                    exc_info=True,
                )
            finally:
                self._queue.task_done()

    def start(self) -> None:
        """Bind the socket and start the worker. Raises if the port is taken."""
        self._worker = threading.Thread(
            target=self._run_worker,
            name="ops-bot-webhook-worker",
            daemon=True,
        )
        self._worker.start()
        self._httpd = _WebhookHTTPServer((self.host, self.port), _WebhookRequestHandler, self)
        logger.info("Webhook listening on http://%s:%d%s", self.host, self.port, self.path)

    def serve_forever(self) -> None:
        if self._httpd is None:
            raise RuntimeError("start() must be called before serve_forever()")
        self._httpd.serve_forever(poll_interval=0.5)

    def stop(self) -> None:
        """Stop accepting, then let the worker finish whatever it already took."""
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._worker is not None and self._worker.is_alive():
            self._queue.put(_STOP)
            self._worker.join(timeout=10.0)
            self._worker = None
