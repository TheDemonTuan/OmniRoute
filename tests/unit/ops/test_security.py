"""Unit tests for Telegram Ops Bot security, cryptography, and redaction."""

import unittest

from scripts.ops.telegram_ops_bot.security import (
    check_access,
    chunk_message,
    escape_html,
    escape_markdown_v2,
    generate_nonce,
    hash_pin,
    is_chat_authorized,
    is_user_authorized,
    redact_sensitive,
    truncate_message,
    verify_pin,
)


class TestSecurity(unittest.TestCase):
    """Test suite for cryptography, access verification, and redaction."""

    def test_hash_and_verify_pin(self) -> None:
        pin = "987654"
        # Test with lightweight scrypt params for fast test execution
        hash_hex, salt_hex = hash_pin(pin, n=1024, r=8, p=1)
        self.assertIsInstance(hash_hex, str)
        self.assertIsInstance(salt_hex, str)
        self.assertEqual(len(bytes.fromhex(salt_hex)), 16)
        self.assertEqual(len(bytes.fromhex(hash_hex)), 64)

        # Verification with correct PIN
        self.assertTrue(verify_pin(pin, hash_hex, salt_hex, n=1024, r=8, p=1))

        # Verification with incorrect PIN
        self.assertFalse(verify_pin("000000", hash_hex, salt_hex, n=1024, r=8, p=1))
        self.assertFalse(verify_pin("", hash_hex, salt_hex, n=1024, r=8, p=1))
        self.assertFalse(verify_pin(pin, "", salt_hex, n=1024, r=8, p=1))
        self.assertFalse(verify_pin(pin, hash_hex, "invalid_hex", n=1024, r=8, p=1))

    def test_generate_nonce(self) -> None:
        nonce1 = generate_nonce(16)
        nonce2 = generate_nonce(16)
        self.assertEqual(len(nonce1), 32)
        self.assertEqual(len(nonce2), 32)
        self.assertNotEqual(nonce1, nonce2)

    def test_redact_telegram_bot_token(self) -> None:
        text = "Bot started with token 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234 on server."
        redacted = redact_sensitive(text)
        self.assertNotIn("123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234", redacted)
        self.assertIn("[REDACTED_BOT_TOKEN]", redacted)

    def test_redact_bearer_token(self) -> None:
        text = "Authorization: Bearer my_secret_bearer_token_123456789"
        redacted = redact_sensitive(text)
        self.assertNotIn("my_secret_bearer_token_123456789", redacted)
        self.assertIn("Bearer [REDACTED_BEARER]", redacted)

    def test_redact_jwt_token(self) -> None:
        jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        text = f"User session JWT: {jwt}"
        redacted = redact_sensitive(text)
        self.assertNotIn("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", redacted)
        self.assertIn("[REDACTED_JWT]", redacted)

    def test_redact_private_key(self) -> None:
        key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0m5...\n-----END RSA PRIVATE KEY-----"
        text = f"Host SSH key:\n{key}\nReady."
        redacted = redact_sensitive(text)
        self.assertNotIn("MIIEowIBAAKCAQEA0m5", redacted)
        self.assertIn("[REDACTED_PRIVATE_KEY]", redacted)

    def test_redact_url_passwords(self) -> None:
        url = "Connecting to postgres://admin:SuperSecretPass123@db.internal:5432/omniroute"
        redacted = redact_sensitive(url)
        self.assertNotIn("SuperSecretPass123", redacted)
        self.assertIn("[REDACTED_PASS]", redacted)

    def test_redact_api_keys_and_github_tokens(self) -> None:
        text = (
            "API configuration: api_key='sk-proj-9876543210abcdefghijklmnop'\n"
            "GitHub token: ghp_1234567890abcdefghijklmnopqrstuvwxyz\n"
            "AWS Key: AKIAIOSFODNN7EXAMPLE"
        )
        redacted = redact_sensitive(text)
        self.assertNotIn("sk-proj-9876543210abcdefghijklmnop", redacted)
        self.assertNotIn("ghp_1234567890abcdefghijklmnopqrstuvwxyz", redacted)
        self.assertNotIn("AKIAIOSFODNN7EXAMPLE", redacted)

    def test_truncate_message(self) -> None:
        short_text = "Status: Healthy"
        self.assertEqual(truncate_message(short_text, max_length=100), short_text)

        long_text = "A" * 5000
        truncated = truncate_message(long_text, max_length=4096, suffix="...[truncated]")
        self.assertEqual(len(truncated), 4096)
        self.assertTrue(truncated.endswith("...[truncated]"))

    def test_chunk_message(self) -> None:
        lines = [f"Line {i:03d} information payload" for i in range(200)]
        big_text = "\n".join(lines)
        chunks = chunk_message(big_text, chunk_size=500)
        self.assertTrue(len(chunks) > 1)
        for c in chunks:
            self.assertLessEqual(len(c), 500)

    def test_html_and_markdown_escaping(self) -> None:
        raw_html = "<script>alert('test & demo')</script>"
        escaped = escape_html(raw_html)
        self.assertNotIn("<script>", escaped)
        self.assertIn("&lt;script&gt;", escaped)
        self.assertIn("&amp;", escaped)

        raw_md = "Hello *world* [link] (test) #1!"
        escaped_md = escape_markdown_v2(raw_md)
        self.assertIn(r"\*", escaped_md)
        self.assertIn(r"\[", escaped_md)
        self.assertIn(r"\!", escaped_md)

    def test_access_checks(self) -> None:
        allowed_users = {100, 200}
        allowed_chats = {500}

        self.assertTrue(is_user_authorized(100, allowed_users))
        self.assertFalse(is_user_authorized(300, allowed_users))
        self.assertFalse(is_user_authorized(None, allowed_users))

        # Private chat enforcement
        self.assertTrue(is_chat_authorized(500, allowed_chats, chat_type="private", require_private_chat=True))
        self.assertFalse(is_chat_authorized(500, allowed_chats, chat_type="group", require_private_chat=True))
        self.assertTrue(is_chat_authorized(500, allowed_chats, chat_type="group", require_private_chat=False))

        # Check access gate
        ok, reason = check_access(
            user_id=100,
            chat_id=500,
            chat_type="private",
            allowed_user_ids=allowed_users,
            allowed_chat_ids=allowed_chats,
            require_private_chat=True,
        )
        self.assertTrue(ok)
        self.assertIsNone(reason)

        # Denied user
        ok, reason = check_access(
            user_id=999,
            chat_id=500,
            chat_type="private",
            allowed_user_ids=allowed_users,
            allowed_chat_ids=allowed_chats,
        )
        self.assertFalse(ok)
        self.assertIn("not in the authorized users list", reason or "")

        # Denied group chat
        ok, reason = check_access(
            user_id=100,
            chat_id=500,
            chat_type="group",
            allowed_user_ids=allowed_users,
            allowed_chat_ids=allowed_chats,
            require_private_chat=True,
        )
        self.assertFalse(ok)
        self.assertIn("private 1:1 direct messages", reason or "")


if __name__ == "__main__":
    unittest.main()
