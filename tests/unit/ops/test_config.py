"""Unit tests for Telegram Ops Bot configuration parsing and validation."""

import os
import sys
import unittest
from unittest.mock import patch

from scripts.ops.telegram_ops_bot.config import (
    BotConfig,
    _parse_bool,
    _parse_int_set,
    load_config_from_env,
)


class TestConfig(unittest.TestCase):
    """Test suite for BotConfig and environment parsing."""

    def test_default_config(self) -> None:
        cfg = BotConfig(
            bot_token="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234",
            allowed_user_ids={111222333},
            pin_hash="hash",
            pin_salt="salt",
        )
        self.assertEqual(cfg.bot_token, "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234")
        self.assertEqual(cfg.allowed_user_ids, {111222333})
        self.assertEqual(cfg.allowed_chat_ids, set())
        self.assertEqual(cfg.poll_timeout, 30)
        self.assertEqual(cfg.poll_interval, 0.5)
        self.assertEqual(cfg.max_retries, 3)
        self.assertEqual(cfg.retry_backoff, 1.5)
        self.assertEqual(cfg.rate_limit_per_minute, 30)
        self.assertEqual(cfg.nonce_ttl_seconds, 300)
        self.assertEqual(cfg.max_pin_attempts, 3)
        self.assertEqual(cfg.lockout_duration_seconds, 900)
        self.assertTrue(cfg.require_private_chat)
        self.assertEqual(cfg.db_path, "data/telegram_ops_bot.sqlite3")
        self.assertEqual(cfg.opsctl_path, "/usr/local/sbin/omniroute-opsctl")
        self.assertIsNone(cfg.github_token)
        self.assertIsNone(cfg.github_repo)
        self.assertEqual(cfg.log_level, "INFO")
        self.assertEqual(cfg.validate(), [])

    def test_main_module_imports_on_python_39(self) -> None:
        sys.modules.pop("scripts.ops.telegram_ops_bot.main", None)
        __import__("scripts.ops.telegram_ops_bot.main")

    def test_alert_threshold_factories_match_runtime_api(self) -> None:
        cfg = BotConfig(
            bot_token="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234",
            allowed_user_ids={111222333},
            pin_hash="hash",
            pin_salt="salt",
        )

        self.assertEqual(cfg.get_resource_thresholds().cpu_warning_pct, 80.0)
        self.assertEqual(cfg.get_action_thresholds().sync_lag_warning_commits, 5)

    def test_load_ops_prefixed_production_config(self) -> None:
        env = {
            "OPS_TELEGRAM_BOT_TOKEN": "987654321:XYZabc12345_67890abcdefghijklm",
            "OPS_TELEGRAM_OWNER_USER_ID": "1001",
            "OPS_TELEGRAM_OWNER_CHAT_ID": "2001",
            "OPS_DB_PATH": "/var/lib/omniroute-ops/ops.sqlite",
            "OPS_OPSCTL_PATH": "/usr/local/sbin/omniroute-opsctl",
            "OPS_PIN_SCRYPT_HASH_B64": "hash",
            "OPS_PIN_SALT_B64": "salt",
            "OPS_GITHUB_REPO": "TheDemonTuan/OmniRoute",
            "OPS_GITHUB_UPSTREAM_REPO": "diegosouzapw/OmniRoute",
        }
        cfg = load_config_from_env(env)
        self.assertEqual(cfg.allowed_user_ids, {1001})
        self.assertEqual(cfg.allowed_chat_ids, {2001})
        self.assertEqual(cfg.db_path, "/var/lib/omniroute-ops/ops.sqlite")
        self.assertEqual(cfg.opsctl_path, "/usr/local/sbin/omniroute-opsctl")
        self.assertEqual(cfg.github_repo, "TheDemonTuan/OmniRoute")

    def test_load_config_from_env(self) -> None:
        env = {
            "TELEGRAM_BOT_TOKEN": "987654321:XYZabc12345_67890abcdefghijklm",
            "TELEGRAM_ALLOWED_USERS": "1001, 1002; 1003",
            "TELEGRAM_ALLOWED_CHATS": "2001,2002",
            "TELEGRAM_PIN_HASH": "abcdef123456",
            "TELEGRAM_PIN_SALT": "fedcba654321",
            "TELEGRAM_DB_PATH": "/var/lib/bot/ops.db",
            "OPSCTL_PATH": "/usr/local/bin/opsctl",
            "TELEGRAM_POLL_TIMEOUT": "45",
            "TELEGRAM_POLL_INTERVAL": "1.0",
            "TELEGRAM_MAX_RETRIES": "5",
            "TELEGRAM_RETRY_BACKOFF": "2.0",
            "RATE_LIMIT_PER_MINUTE": "60",
            "NONCE_TTL_SECONDS": "600",
            "MAX_PIN_ATTEMPTS": "5",
            "LOCKOUT_DURATION_SECONDS": "1800",
            "REQUIRE_PRIVATE_CHAT": "false",
            "GITHUB_TOKEN": "ghp_mocktoken1234567890",
            "GITHUB_REPOSITORY": "org/omniroute",
            "LOG_LEVEL": "DEBUG",
        }
        cfg = load_config_from_env(env)
        self.assertEqual(cfg.bot_token, "987654321:XYZabc12345_67890abcdefghijklm")
        self.assertEqual(cfg.allowed_user_ids, {1001, 1002, 1003})
        self.assertEqual(cfg.allowed_chat_ids, {2001, 2002})
        self.assertEqual(cfg.pin_hash, "abcdef123456")
        self.assertEqual(cfg.pin_salt, "fedcba654321")
        self.assertEqual(cfg.db_path, "/var/lib/bot/ops.db")
        self.assertEqual(cfg.opsctl_path, "/usr/local/bin/opsctl")
        self.assertEqual(cfg.poll_timeout, 45)
        self.assertEqual(cfg.poll_interval, 1.0)
        self.assertEqual(cfg.max_retries, 5)
        self.assertEqual(cfg.retry_backoff, 2.0)
        self.assertEqual(cfg.rate_limit_per_minute, 60)
        self.assertEqual(cfg.nonce_ttl_seconds, 600)
        self.assertEqual(cfg.max_pin_attempts, 5)
        self.assertEqual(cfg.lockout_duration_seconds, 1800)
        self.assertFalse(cfg.require_private_chat)
        self.assertEqual(cfg.github_token, "ghp_mocktoken1234567890")
        self.assertEqual(cfg.github_repo, "org/omniroute")
        self.assertEqual(cfg.log_level, "DEBUG")

    def test_parse_int_set(self) -> None:
        self.assertEqual(_parse_int_set(""), set())
        self.assertEqual(_parse_int_set(None), set())
        self.assertEqual(_parse_int_set(" 123 , 456 \n 789 ; 001 "), {123, 456, 789, 1})
        self.assertEqual(_parse_int_set("123, invalid, 456"), {123, 456})

    def test_parse_bool(self) -> None:
        self.assertTrue(_parse_bool("true"))
        self.assertTrue(_parse_bool("1"))
        self.assertTrue(_parse_bool("YES"))
        self.assertTrue(_parse_bool("on"))
        self.assertFalse(_parse_bool("false"))
        self.assertFalse(_parse_bool("0"))
        self.assertFalse(_parse_bool("no"))
        self.assertFalse(_parse_bool("off"))
        self.assertTrue(_parse_bool(None, default=True))
        self.assertFalse(_parse_bool(None, default=False))

    def test_validation_errors(self) -> None:
        # Empty token and empty allowed_users
        cfg = BotConfig(bot_token="", allowed_user_ids=set())
        errors = cfg.validate()
        self.assertTrue(any("bot_token is required" in e for e in errors))
        self.assertTrue(any("allowed_user_ids must contain" in e for e in errors))

        # Invalid token format
        cfg2 = BotConfig(bot_token="invalid-token", allowed_user_ids={123})
        errors2 = cfg2.validate()
        self.assertTrue(any("does not match expected Telegram bot token format" in e for e in errors2))

        # Pin hash without salt
        cfg3 = BotConfig(
            bot_token="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234",
            allowed_user_ids={123},
            pin_hash="hashonly",
        )
        errors3 = cfg3.validate()
        self.assertTrue(any("pin_salt must be provided" in e for e in errors3))

        # Invalid poll timeout
        cfg4 = BotConfig(
            bot_token="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234",
            allowed_user_ids={123},
            poll_timeout=0,
        )
        errors4 = cfg4.validate()
        self.assertTrue(any("poll_timeout must be between 1 and 120" in e for e in errors4))


if __name__ == "__main__":
    unittest.main()
