"""Unit tests for GitHub App authentication, token caching, and REST client."""

import base64
import io
import json
import os
import subprocess
import tempfile
import unittest
import urllib.error
from unittest.mock import MagicMock, patch

from scripts.ops.telegram_ops_bot.github import (
    GitHubAuthError,
    GitHubClient,
    GitHubError,
    GitHubNotFoundError,
    GitHubPermissionError,
    GitHubRateLimitError,
    GitHubValidationError,
    RateLimitInfo,
    b64url_decode,
    b64url_encode,
    generate_jwt,
    parse_iso8601_timestamp,
    redact_sensitive,
)


class MockHTTPResponse:
    """Mock urllib response object."""

    def __init__(
        self,
        body: bytes,
        code: int = 200,
        headers: dict = None,
    ) -> None:
        self._body = body
        self.code = code
        self.status = code
        self.headers = MagicMock()
        headers_dict = headers or {}
        self.headers.items = MagicMock(return_value=list(headers_dict.items()))
        self.headers.get = lambda k, d=None: headers_dict.get(k.lower(), d)

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


class TestGitHubAuthAndClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Generate a test RSA private key using openssl for testing JWT signing
        proc = subprocess.run(
            ["openssl", "genrsa", "2048"],
            capture_output=True,
            check=True,
        )
        cls.test_rsa_pem = proc.stdout.decode("ascii")

    def test_redact_sensitive_tokens_and_keys(self):
        sample = (
            f"Token is ghp_1234567890abcdefghijklmnopqrstuvwxyz and key is:\n"
            f"{self.test_rsa_pem}\n"
            f"Bearer header: Bearer ghs_secrettoken1234567890abcdefghijklmnopqrst"
        )
        redacted = redact_sensitive(sample)
        self.assertNotIn("ghp_1234567890", redacted)
        self.assertNotIn("ghs_secrettoken", redacted)
        self.assertNotIn("BEGIN RSA PRIVATE KEY", redacted)
        self.assertIn("[REDACTED TOKEN]", redacted)
        self.assertIn("[REDACTED PRIVATE KEY]", redacted)
        self.assertIn("Bearer [REDACTED]", redacted)

    def test_b64url_encode_and_decode(self):
        data = b"Hello, World! OmniRoute Ops Bot test \x00\xff"
        encoded = b64url_encode(data)
        self.assertNotIn("=", encoded)
        self.assertNotIn("+", encoded)
        self.assertNotIn("/", encoded)
        decoded = b64url_decode(encoded)
        self.assertEqual(decoded, data)

    def test_parse_iso8601_timestamp(self):
        ts = parse_iso8601_timestamp("2026-08-24T12:00:00Z")
        self.assertGreater(ts, 1700000000)

        ts2 = parse_iso8601_timestamp("2026-08-24T12:00:00+00:00")
        self.assertEqual(ts, ts2)

    def test_generate_jwt_valid_signature(self):
        jwt_str = generate_jwt(app_id="123456", private_key=self.test_rsa_pem, expiration_seconds=300)
        parts = jwt_str.split(".")
        self.assertEqual(len(parts), 3)

        # Verify header
        header = json.loads(b64url_decode(parts[0]).decode("utf-8"))
        self.assertEqual(header, {"alg": "RS256", "typ": "JWT"})

        # Verify payload
        payload = json.loads(b64url_decode(parts[1]).decode("utf-8"))
        self.assertEqual(payload["iss"], "123456")
        self.assertIn("iat", payload)
        self.assertIn("exp", payload)
        self.assertEqual(payload["exp"] - payload["iat"], 360)  # 300 + 60s iat drift

        # Verify signature length
        sig_bytes = b64url_decode(parts[2])
        self.assertEqual(len(sig_bytes), 256)  # 2048-bit RSA signature = 256 bytes

    def test_generate_jwt_with_file_path(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write(self.test_rsa_pem)
            key_file = f.name

        try:
            jwt_str = generate_jwt(app_id=7890, private_key=key_file, expiration_seconds=600)
            self.assertEqual(len(jwt_str.split(".")), 3)
        finally:
            if os.path.exists(key_file):
                os.remove(key_file)

    def test_generate_jwt_invalid_key_fails(self):
        with self.assertRaises(GitHubAuthError):
            generate_jwt(app_id="123", private_key="INVALID_PEM_CONTENT")

    def test_mint_installation_token_and_caching(self):
        mock_response = {
            "token": "ghs_testinstallationtoken1234567890",
            "expires_at": "2026-08-24T15:00:00Z",
            "permissions": {"issues": "write", "actions": "write"},
            "repository_selection": "selected",
        }

        mock_opener = MagicMock()
        mock_opener.return_value = MockHTTPResponse(
            body=json.dumps(mock_response).encode("utf-8"),
            code=201,
            headers={"Content-Type": "application/json"},
        )

        client = GitHubClient(
            app_id="12345",
            private_key=self.test_rsa_pem,
            installation_id="999",
            opener=mock_opener,
        )

        with patch("scripts.ops.telegram_ops_bot.github.time.time", return_value=1787570000.0):
            token1 = client.mint_installation_token()
            self.assertEqual(token1, "ghs_testinstallationtoken1234567890")
            self.assertEqual(mock_opener.call_count, 1)

            # Second call should use cache
            token2 = client.mint_installation_token()
            self.assertEqual(token2, token1)
            self.assertEqual(mock_opener.call_count, 1)

            # Force refresh should call API again
            token3 = client.mint_installation_token(force_refresh=True)
            self.assertEqual(token3, token1)
            self.assertEqual(mock_opener.call_count, 2)

    def test_rest_client_get_and_post(self):
        mock_opener = MagicMock()
        mock_opener.return_value = MockHTTPResponse(
            body=json.dumps({"login": "test-user", "id": 1}).encode("utf-8"),
            code=200,
            headers={
                "X-RateLimit-Limit": "5000",
                "X-RateLimit-Remaining": "4999",
                "X-RateLimit-Reset": "1724500000",
                "X-RateLimit-Used": "1",
            },
        )

        client = GitHubClient(token="ghp_testpersonaltoken1234567890", opener=mock_opener)

        # GET request
        res = client.get("/user", params={"extra": "true"})
        self.assertEqual(res["login"], "test-user")

        rate_info = client.get_rate_limit_info()
        self.assertIsNotNone(rate_info)
        self.assertEqual(rate_info.remaining, 4999)
        self.assertEqual(rate_info.limit, 5000)

        # POST request
        mock_opener.return_value = MockHTTPResponse(
            body=json.dumps({"id": 101, "name": "new-item"}).encode("utf-8"),
            code=201,
        )
        res_post = client.post("/repos/owner/repo/items", json_data={"name": "new-item"})
        self.assertEqual(res_post["id"], 101)

    def test_rest_client_204_no_content(self):
        mock_opener = MagicMock()
        mock_opener.return_value = MockHTTPResponse(body=b"", code=204)

        client = GitHubClient(token="ghp_token", opener=mock_opener)
        res = client.delete("/repos/owner/repo/item/1")
        self.assertEqual(res, {})

    def test_rest_client_error_handling(self):
        client = GitHubClient(token="ghp_test")

        # 401 Unauthorized
        def raise_401(*args, **kwargs):
            fp = io.BytesIO(b'{"message": "Bad credentials"}')
            raise urllib.error.HTTPError("https://api.github.com/user", 401, "Unauthorized", {}, fp)

        client._opener = raise_401
        with self.assertRaises(GitHubAuthError) as ctx:
            client.get("/user")
        self.assertEqual(ctx.exception.status_code, 401)

        # 404 Not Found
        def raise_404(*args, **kwargs):
            fp = io.BytesIO(b'{"message": "Not Found"}')
            raise urllib.error.HTTPError("https://api.github.com/repos/x/y", 404, "Not Found", {}, fp)

        client._opener = raise_404
        with self.assertRaises(GitHubNotFoundError) as ctx:
            client.get("/repos/x/y")
        self.assertEqual(ctx.exception.status_code, 404)

        # 429 Rate Limit
        def raise_429(*args, **kwargs):
            fp = io.BytesIO(b'{"message": "API rate limit exceeded"}')
            hdrs = {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1724509999", "retry-after": "60"}
            mock_hdrs = MagicMock()
            mock_hdrs.items = lambda: list(hdrs.items())
            raise urllib.error.HTTPError("https://api.github.com/rate", 429, "Too Many Requests", mock_hdrs, fp)

        client._opener = raise_429
        with self.assertRaises(GitHubRateLimitError) as ctx:
            client.get("/rate")
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertEqual(ctx.exception.reset_timestamp, 1724509999)
        self.assertEqual(ctx.exception.retry_after, 60)

        # 422 Validation Error
        def raise_422(*args, **kwargs):
            fp = io.BytesIO(b'{"message": "Validation Failed", "errors": ["invalid field"]}')
            raise urllib.error.HTTPError("https://api.github.com/val", 422, "Unprocessable Entity", {}, fp)

        client._opener = raise_422
        with self.assertRaises(GitHubValidationError) as ctx:
            client.post("/val", json_data={})
        self.assertEqual(ctx.exception.status_code, 422)

    def test_paginate_and_list_all(self):
        page1 = [{"id": 1}, {"id": 2}]
        page2 = [{"id": 3}]

        def side_effect(req, *args, **kwargs):
            if "page=1" in req.full_url:
                return MockHTTPResponse(json.dumps(page1).encode("utf-8"), 200)
            elif "page=2" in req.full_url:
                return MockHTTPResponse(json.dumps(page2).encode("utf-8"), 200)
            return MockHTTPResponse(json.dumps([]).encode("utf-8"), 200)

        client = GitHubClient(token="ghp_token", opener=side_effect)
        items = client.list_all("/repos/owner/repo/issues", per_page=2)
        self.assertEqual(len(items), 3)
        self.assertEqual([i["id"] for i in items], [1, 2, 3])

    def test_paginate_check_runs_wrapper(self):
        page1 = {"total_count": 3, "check_runs": [{"id": 1}, {"id": 2}]}
        page2 = {"total_count": 3, "check_runs": [{"id": 3}]}

        def side_effect(req, *args, **kwargs):
            payload = page1 if "page=1" in req.full_url else page2
            return MockHTTPResponse(json.dumps(payload).encode("utf-8"), 200)

        client = GitHubClient(token="ghp_token", opener=side_effect)
        items = client.list_all("/repos/owner/repo/commits/sha/check-runs", per_page=2)

        self.assertEqual([item["id"] for item in items], [1, 2, 3])


if __name__ == "__main__":
    unittest.main()
