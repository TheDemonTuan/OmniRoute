"""Unit tests for the Telegram Ops Bot webhook receiver."""

import json
import threading
import time
import unittest
import urllib.error
import urllib.request

from scripts.ops.telegram_ops_bot.webhook import WebhookServer


PATH = "/tg-ops/abcdef0123456789"
SECRET = "s" * 32


class FakeState:
    """Minimal stand-in for StateManager's offset accessors."""

    def __init__(self, offset: int = 0) -> None:
        self.offset = offset
        self.raise_on_read = False

    def get_offset(self) -> int:
        if self.raise_on_read:
            raise RuntimeError("database is locked")
        return self.offset

    def set_offset(self, offset: int) -> None:
        self.offset = offset


class WebhookAcceptTest(unittest.TestCase):
    """accept() carries the dedup and queueing rules; exercise it directly."""

    def setUp(self) -> None:
        self.handled = []
        self.state = FakeState()
        self.server = WebhookServer(
            dispatch=self.handled.append,
            state=self.state,
            path=PATH,
            secret_token=SECRET,
        )

    def test_accepts_a_fresh_update_and_advances_the_offset(self):
        accepted, status = self.server.accept({"update_id": 7, "message": {}})
        self.assertTrue(accepted)
        self.assertEqual(status, 200)
        self.assertEqual(self.state.offset, 8)

    def test_skips_an_update_already_covered_by_the_offset(self):
        self.state.offset = 10
        accepted, status = self.server.accept({"update_id": 4, "message": {}})
        # Acknowledged so Telegram stops redelivering, but not queued: this is
        # the only guard against a retry re-running a destructive action.
        self.assertTrue(accepted)
        self.assertEqual(status, 200)
        self.assertTrue(self.server._queue.empty())
        self.assertEqual(self.state.offset, 10)

    def test_rejects_an_update_without_a_usable_id(self):
        self.assertEqual(self.server.accept({"message": {}}), (False, 400))
        self.assertEqual(self.server.accept({"update_id": "7"}), (False, 400))
        self.assertEqual(self.server.accept({"update_id": True}), (False, 400))

    def test_asks_for_a_retry_when_the_offset_cannot_be_read(self):
        self.state.raise_on_read = True
        accepted, status = self.server.accept({"update_id": 1})
        self.assertFalse(accepted)
        self.assertEqual(status, 503)

    def test_asks_for_a_retry_instead_of_dropping_when_the_queue_is_full(self):
        server = WebhookServer(
            dispatch=self.handled.append,
            state=self.state,
            path=PATH,
            secret_token=SECRET,
            queue_size=1,
        )
        self.assertEqual(server.accept({"update_id": 1}), (True, 200))
        accepted, status = server.accept({"update_id": 2})
        self.assertFalse(accepted)
        self.assertEqual(status, 503)


class WebhookHTTPTest(unittest.TestCase):
    """End-to-end over a real loopback socket on an ephemeral port."""

    def setUp(self) -> None:
        self.handled = []
        self.done = threading.Event()

        def dispatch(update):
            self.handled.append(update)
            self.done.set()

        self.state = FakeState()
        self.server = WebhookServer(
            dispatch=dispatch,
            state=self.state,
            path=PATH,
            secret_token=SECRET,
            port=0,
            max_body_bytes=2048,
        )
        self.server.start()
        self.port = self.server._httpd.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.stop()
        self.thread.join(timeout=5.0)

    def _post(self, path=PATH, secret=SECRET, body=None, raw=None):
        payload = raw if raw is not None else json.dumps(body or {}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=payload,
            method="POST",
        )
        if secret is not None:
            req.add_header("X-Telegram-Bot-Api-Secret-Token", secret)
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                return resp.status
        except urllib.error.HTTPError as err:
            return err.code

    def test_delivers_a_valid_update_to_the_dispatcher(self):
        self.assertEqual(self._post(body={"update_id": 1, "message": {"text": "/status"}}), 200)
        self.assertTrue(self.done.wait(timeout=5.0))
        self.assertEqual(self.handled[0]["update_id"], 1)

    def test_rejects_a_wrong_secret_token(self):
        self.assertEqual(self._post(secret="x" * 32, body={"update_id": 1}), 401)
        self.assertEqual(self.handled, [])

    def test_rejects_a_missing_secret_token(self):
        self.assertEqual(self._post(secret=None, body={"update_id": 1}), 401)
        self.assertEqual(self.handled, [])

    def test_hides_the_endpoint_behind_the_secret_path(self):
        self.assertEqual(self._post(path="/tg-ops/wrong", body={"update_id": 1}), 404)
        self.assertEqual(self._post(path="/", body={"update_id": 1}), 404)
        self.assertEqual(self.handled, [])

    def test_refuses_an_oversized_body(self):
        big = json.dumps({"update_id": 1, "pad": "x" * 4096}).encode("utf-8")
        self.assertEqual(self._post(raw=big), 413)
        self.assertEqual(self.handled, [])

    def test_refuses_a_body_that_is_not_json(self):
        self.assertEqual(self._post(raw=b"not json at all"), 400)
        self.assertEqual(self.handled, [])

    def test_refuses_a_json_body_that_is_not_an_object(self):
        self.assertEqual(self._post(raw=b'"just a string"'), 400)
        self.assertEqual(self.handled, [])

    def test_acknowledges_before_the_handler_finishes(self):
        """A slow action must not hold the response open into Telegram's retry."""
        release = threading.Event()
        started = threading.Event()

        def slow_dispatch(update):
            started.set()
            release.wait(timeout=5.0)

        self.server.dispatch = slow_dispatch
        began = time.monotonic()
        status = self._post(body={"update_id": 99, "message": {}})
        elapsed = time.monotonic() - began

        self.assertEqual(status, 200)
        self.assertLess(elapsed, 2.0)
        self.assertTrue(started.wait(timeout=5.0))
        release.set()

    def test_rejects_methods_other_than_post(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{PATH}", method="GET")
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                status = resp.status
        except urllib.error.HTTPError as err:
            status = err.code
        self.assertEqual(status, 405)


if __name__ == "__main__":
    unittest.main()
