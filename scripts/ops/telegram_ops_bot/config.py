"""Configuration module for Telegram Ops Bot.

Handles environment variable parsing, configuration dataclass definitions,
and validation logic using only standard library.
"""

import os
import re
from dataclasses import dataclass, field
from typing import Mapping, Optional, Set, List

from .alerts import ActionThresholds, ResourceThresholds


TOKEN_PATTERN = re.compile(r"^\d{6,14}:[A-Za-z0-9_\-]{30,50}$")


@dataclass(frozen=True)
class BotConfig:
    """Immutable configuration container for Telegram Ops Bot."""

    bot_token: str
    allowed_user_ids: Set[int] = field(default_factory=set)
    allowed_chat_ids: Set[int] = field(default_factory=set)
    pin_hash: Optional[str] = None
    pin_salt: Optional[str] = None
    db_path: str = "data/telegram_ops_bot.sqlite3"
    opsctl_path: str = "/usr/local/sbin/omniroute-opsctl"
    poll_timeout: int = 30
    poll_interval: float = 0.5
    max_retries: int = 3
    retry_backoff: float = 1.5
    rate_limit_per_minute: int = 30
    nonce_ttl_seconds: int = 300
    max_pin_attempts: int = 3
    lockout_duration_seconds: int = 900
    require_private_chat: bool = True
    github_token: Optional[str] = None
    github_repo: Optional[str] = None
    github_upstream_repo: str = "diegosouzapw/OmniRoute"
    github_app_id: Optional[str] = None
    github_installation_id: Optional[str] = None
    github_private_key_file: Optional[str] = None
    log_level: str = "INFO"
    owner_chat_id: Optional[int] = None
    alert_eval_interval_seconds: float = 60.0
    alert_cooldown_seconds: float = 900.0
    alert_debounce_consecutive: int = 1
    alert_cpu_warning_pct: float = 80.0
    alert_cpu_critical_pct: float = 90.0
    alert_memory_warning_pct: float = 80.0
    alert_memory_critical_pct: float = 90.0
    alert_disk_warning_pct: float = 80.0
    alert_disk_critical_pct: float = 90.0
    alert_workflow_failure_threshold: int = 2
    alert_rate_limit_warning_pct: float = 20.0
    alert_rate_limit_critical_pct: float = 10.0
    alert_sync_lag_warning_commits: int = 5
    alert_sync_lag_critical_commits: int = 15
    alert_actions_delay_warning_seconds: float = 1800.0
    alert_actions_delay_critical_seconds: float = 3600.0

    def get_resource_thresholds(self) -> ResourceThresholds:
        """Construct ResourceThresholds from current config values."""
        return ResourceThresholds(
            cpu_warning_pct=self.alert_cpu_warning_pct,
            cpu_critical_pct=self.alert_cpu_critical_pct,
            memory_warning_pct=self.alert_memory_warning_pct,
            memory_critical_pct=self.alert_memory_critical_pct,
            disk_warning_pct=self.alert_disk_warning_pct,
            disk_critical_pct=self.alert_disk_critical_pct,
        )

    def get_action_thresholds(self) -> ActionThresholds:
        """Construct ActionThresholds from current config values."""
        return ActionThresholds(
            consecutive_workflow_failures=self.alert_workflow_failure_threshold,
            rate_limit_warning_pct=self.alert_rate_limit_warning_pct,
            rate_limit_critical_pct=self.alert_rate_limit_critical_pct,
            sync_lag_warning_commits=self.alert_sync_lag_warning_commits,
            sync_lag_critical_commits=self.alert_sync_lag_critical_commits,
            workflow_delay_warning_seconds=self.alert_actions_delay_warning_seconds,
            workflow_delay_critical_seconds=self.alert_actions_delay_critical_seconds,
        )

    def validate(self) -> List[str]:
        """Validate configuration parameters. Returns list of error messages (empty if valid)."""
        errors: List[str] = []
        if not self.bot_token or not self.bot_token.strip():
            errors.append("bot_token is required and cannot be empty")
        elif not TOKEN_PATTERN.match(self.bot_token.strip()):
            errors.append("bot_token does not match expected Telegram bot token format (e.g. 123456789:ABCdef...)")

        if not self.allowed_user_ids:
            errors.append("allowed_user_ids must contain at least one authorized user ID")
        else:
            for uid in self.allowed_user_ids:
                if not isinstance(uid, int) or uid <= 0:
                    errors.append(f"Invalid user ID in allowed_user_ids: {uid} (must be a positive integer)")

        for cid in self.allowed_chat_ids:
            if not isinstance(cid, int):
                errors.append(f"Invalid chat ID in allowed_chat_ids: {cid} (must be an integer)")

        if self.pin_hash and not self.pin_salt:
            errors.append("pin_salt must be provided when pin_hash is set")
        if self.pin_salt and not self.pin_hash:
            errors.append("pin_hash must be provided when pin_salt is set")
        if not self.pin_hash or not self.pin_salt:
            errors.append("PIN hash and salt are required for production operations")

        app_values = [self.github_app_id, self.github_installation_id, self.github_private_key_file]
        if any(app_values) and not all(app_values):
            errors.append(
                "github_app_id, github_installation_id, and github_private_key_file must be configured together"
            )
        if self.github_private_key_file and not os.path.isfile(self.github_private_key_file):
            errors.append("github_private_key_file does not exist")

        if self.poll_timeout < 1 or self.poll_timeout > 120:
            errors.append(f"poll_timeout must be between 1 and 120 seconds, got {self.poll_timeout}")

        if self.nonce_ttl_seconds < 10:
            errors.append(f"nonce_ttl_seconds must be at least 10 seconds, got {self.nonce_ttl_seconds}")

        if self.max_pin_attempts < 1:
            errors.append(f"max_pin_attempts must be at least 1, got {self.max_pin_attempts}")

        if self.lockout_duration_seconds < 0:
            errors.append(f"lockout_duration_seconds cannot be negative, got {self.lockout_duration_seconds}")

        if self.alert_eval_interval_seconds <= 0:
            errors.append(f"alert_eval_interval_seconds must be positive, got {self.alert_eval_interval_seconds}")

        if self.alert_cooldown_seconds < 0:
            errors.append(f"alert_cooldown_seconds cannot be negative, got {self.alert_cooldown_seconds}")

        if self.alert_debounce_consecutive < 1:
            errors.append(f"alert_debounce_consecutive must be at least 1, got {self.alert_debounce_consecutive}")

        if not (0.0 <= self.alert_cpu_warning_pct <= self.alert_cpu_critical_pct <= 100.0):
            errors.append("CPU thresholds must satisfy 0 <= warning <= critical <= 100")

        if not (0.0 <= self.alert_memory_warning_pct <= self.alert_memory_critical_pct <= 100.0):
            errors.append("Memory thresholds must satisfy 0 <= warning <= critical <= 100")

        if not (0.0 <= self.alert_disk_warning_pct <= self.alert_disk_critical_pct <= 100.0):
            errors.append("Disk thresholds must satisfy 0 <= warning <= critical <= 100")

        return errors


def _parse_int_set(raw_value: Optional[str]) -> Set[int]:
    """Parse comma/whitespace separated integer IDs into a set."""
    if not raw_value:
        return set()
    result: Set[int] = set()
    for chunk in re.split(r"[,;\s]+", raw_value.strip()):
        if chunk:
            try:
                result.add(int(chunk))
            except ValueError:
                pass
    return result


def _parse_bool(val: Optional[str], default: bool = True) -> bool:
    """Parse boolean environment variable."""
    if val is None:
        return default
    cleaned = val.strip().lower()
    if cleaned in ("true", "1", "yes", "y", "t", "on"):
        return True
    if cleaned in ("false", "0", "no", "n", "f", "off"):
        return False
    return default


def load_config_from_env(env: Optional[Mapping[str, str]] = None) -> BotConfig:
    """Load configuration from environment or provided mapping."""
    e = os.environ if env is None else env

    bot_token = (
        e.get("OPS_TELEGRAM_BOT_TOKEN")
        or e.get("TELEGRAM_BOT_TOKEN")
        or e.get("TELEGRAM_OPS_BOT_TOKEN")
        or e.get("BOT_TOKEN")
        or ""
    ).strip()

    allowed_users_raw = (
        e.get("OPS_TELEGRAM_OWNER_USER_ID")
        or e.get("TELEGRAM_ALLOWED_USERS")
        or e.get("ALLOWED_USER_IDS")
        or e.get("TELEGRAM_BOT_ALLOWED_USERS")
        or ""
    )
    allowed_user_ids = _parse_int_set(allowed_users_raw)

    allowed_chats_raw = (
        e.get("OPS_TELEGRAM_OWNER_CHAT_ID")
        or e.get("TELEGRAM_ALLOWED_CHATS")
        or e.get("ALLOWED_CHAT_IDS")
        or e.get("TELEGRAM_BOT_ALLOWED_CHATS")
        or ""
    )
    allowed_chat_ids = _parse_int_set(allowed_chats_raw)

    pin_hash = e.get("OPS_PIN_SCRYPT_HASH_B64") or e.get("TELEGRAM_PIN_HASH") or e.get("PIN_HASH") or None
    if pin_hash:
        pin_hash = pin_hash.strip()

    pin_salt = e.get("OPS_PIN_SALT_B64") or e.get("TELEGRAM_PIN_SALT") or e.get("PIN_SALT") or None
    if pin_salt:
        pin_salt = pin_salt.strip()

    db_path = (
        e.get("OPS_DB_PATH")
        or e.get("TELEGRAM_DB_PATH")
        or e.get("DB_PATH")
        or e.get("TELEGRAM_OPS_BOT_DB")
        or "data/telegram_ops_bot.sqlite3"
    ).strip()

    opsctl_path = (
        e.get("OPS_OPSCTL_PATH")
        or e.get("OPSCTL_PATH")
        or "/usr/local/sbin/omniroute-opsctl"
    ).strip()

    poll_timeout = int(e.get("TELEGRAM_POLL_TIMEOUT", e.get("POLL_TIMEOUT", "30")))
    poll_interval = float(e.get("TELEGRAM_POLL_INTERVAL", e.get("POLL_INTERVAL", "0.5")))
    max_retries = int(e.get("TELEGRAM_MAX_RETRIES", e.get("MAX_RETRIES", "3")))
    retry_backoff = float(e.get("TELEGRAM_RETRY_BACKOFF", e.get("RETRY_BACKOFF", "1.5")))
    rate_limit_per_minute = int(e.get("RATE_LIMIT_PER_MINUTE", "30"))
    nonce_ttl_seconds = int(e.get("NONCE_TTL_SECONDS", "300"))
    max_pin_attempts = int(e.get("MAX_PIN_ATTEMPTS", "3"))
    lockout_duration_seconds = int(e.get("LOCKOUT_DURATION_SECONDS", "900"))
    require_private_chat = _parse_bool(e.get("REQUIRE_PRIVATE_CHAT"), default=True)

    github_token = e.get("GITHUB_TOKEN") or e.get("GH_TOKEN") or None
    if github_token:
        github_token = github_token.strip()

    github_repo = e.get("OPS_GITHUB_REPO") or e.get("GITHUB_REPOSITORY") or e.get("GITHUB_REPO") or None
    if github_repo:
        github_repo = github_repo.strip()
    github_upstream_repo = e.get("OPS_GITHUB_UPSTREAM_REPO", "diegosouzapw/OmniRoute").strip()
    github_app_id = e.get("OPS_GITHUB_APP_ID") or None
    github_installation_id = e.get("OPS_GITHUB_INSTALLATION_ID") or None
    github_private_key_file = e.get("OPS_GITHUB_PRIVATE_KEY_FILE") or None

    log_level = e.get("LOG_LEVEL", "INFO").strip().upper()

    owner_chat_raw = e.get("OPS_TELEGRAM_OWNER_CHAT_ID") or e.get("OPS_ALERT_CHAT_ID") or e.get("TELEGRAM_OWNER_CHAT_ID")
    owner_chat_id: Optional[int] = None
    if owner_chat_raw:
        for chunk in re.split(r"[,;\s]+", owner_chat_raw.strip()):
            if chunk:
                try:
                    owner_chat_id = int(chunk)
                    break
                except ValueError:
                    pass
    if owner_chat_id is None and len(allowed_chat_ids) == 1:
        owner_chat_id = next(iter(allowed_chat_ids))

    alert_eval_interval_seconds = float(
        e.get("OPS_ALERT_INTERVAL_SECONDS", e.get("OPS_ALERT_INTERVAL", e.get("ALERT_INTERVAL_SECONDS", "60.0")))
    )
    alert_cooldown_seconds = float(
        e.get("OPS_ALERT_COOLDOWN_SECONDS", e.get("OPS_ALERT_COOLDOWN", e.get("ALERT_COOLDOWN_SECONDS", "900.0")))
    )
    alert_debounce_consecutive = int(
        e.get("OPS_ALERT_DEBOUNCE_CONSECUTIVE", e.get("OPS_ALERT_DEBOUNCE", e.get("ALERT_DEBOUNCE", "1")))
    )
    alert_cpu_warning_pct = float(
        e.get("OPS_ALERT_CPU_WARNING_PCT", e.get("OPS_CPU_WARNING_PCT", e.get("ALERT_CPU_WARNING_PCT", "80.0")))
    )
    alert_cpu_critical_pct = float(
        e.get("OPS_ALERT_CPU_CRITICAL_PCT", e.get("OPS_CPU_CRITICAL_PCT", e.get("ALERT_CPU_CRITICAL_PCT", "90.0")))
    )
    alert_memory_warning_pct = float(
        e.get("OPS_ALERT_MEMORY_WARNING_PCT", e.get("OPS_MEMORY_WARNING_PCT", e.get("ALERT_MEMORY_WARNING_PCT", "80.0")))
    )
    alert_memory_critical_pct = float(
        e.get("OPS_ALERT_MEMORY_CRITICAL_PCT", e.get("OPS_MEMORY_CRITICAL_PCT", e.get("ALERT_MEMORY_CRITICAL_PCT", "90.0")))
    )
    alert_disk_warning_pct = float(
        e.get("OPS_ALERT_DISK_WARNING_PCT", e.get("OPS_DISK_WARNING_PCT", e.get("ALERT_DISK_WARNING_PCT", "80.0")))
    )
    alert_disk_critical_pct = float(
        e.get("OPS_ALERT_DISK_CRITICAL_PCT", e.get("OPS_DISK_CRITICAL_PCT", e.get("ALERT_DISK_CRITICAL_PCT", "90.0")))
    )
    alert_workflow_failure_threshold = int(
        e.get(
            "OPS_ALERT_WORKFLOW_FAILURE_THRESHOLD",
            e.get("OPS_ALERT_CONSECUTIVE_WORKFLOW_FAILURES", e.get("OPS_WORKFLOW_FAILURE_THRESHOLD", "2")),
        )
    )
    alert_rate_limit_warning_pct = float(
        e.get("OPS_ALERT_RATE_LIMIT_WARNING_PCT", e.get("OPS_RATE_LIMIT_WARNING_PCT", "20.0"))
    )
    alert_rate_limit_critical_pct = float(
        e.get("OPS_ALERT_RATE_LIMIT_CRITICAL_PCT", e.get("OPS_RATE_LIMIT_CRITICAL_PCT", "10.0"))
    )
    alert_sync_lag_warning_commits = int(
        e.get("OPS_ALERT_SYNC_LAG_WARNING_COMMITS", e.get("OPS_SYNC_LAG_WARNING_COMMITS", "5"))
    )
    alert_sync_lag_critical_commits = int(
        e.get("OPS_ALERT_SYNC_LAG_CRITICAL_COMMITS", e.get("OPS_SYNC_LAG_CRITICAL_COMMITS", "15"))
    )
    alert_actions_delay_warning_seconds = float(
        e.get(
            "OPS_ALERT_ACTIONS_DELAY_WARNING_SECONDS",
            e.get("OPS_ALERT_WORKFLOW_DELAY_WARNING_SECONDS", e.get("OPS_ACTIONS_DELAY_WARNING_SECONDS", "1800.0")),
        )
    )
    alert_actions_delay_critical_seconds = float(
        e.get(
            "OPS_ALERT_ACTIONS_DELAY_CRITICAL_SECONDS",
            e.get("OPS_ALERT_WORKFLOW_DELAY_CRITICAL_SECONDS", e.get("OPS_ACTIONS_DELAY_CRITICAL_SECONDS", "3600.0")),
        )
    )

    return BotConfig(
        bot_token=bot_token,
        allowed_user_ids=allowed_user_ids,
        allowed_chat_ids=allowed_chat_ids,
        pin_hash=pin_hash,
        pin_salt=pin_salt,
        db_path=db_path,
        opsctl_path=opsctl_path,
        poll_timeout=poll_timeout,
        poll_interval=poll_interval,
        max_retries=max_retries,
        retry_backoff=retry_backoff,
        rate_limit_per_minute=rate_limit_per_minute,
        nonce_ttl_seconds=nonce_ttl_seconds,
        max_pin_attempts=max_pin_attempts,
        lockout_duration_seconds=lockout_duration_seconds,
        require_private_chat=require_private_chat,
        github_token=github_token,
        github_repo=github_repo,
        github_upstream_repo=github_upstream_repo,
        github_app_id=github_app_id,
        github_installation_id=github_installation_id,
        github_private_key_file=github_private_key_file,
        log_level=log_level,
        owner_chat_id=owner_chat_id,
        alert_eval_interval_seconds=alert_eval_interval_seconds,
        alert_cooldown_seconds=alert_cooldown_seconds,
        alert_debounce_consecutive=alert_debounce_consecutive,
        alert_cpu_warning_pct=alert_cpu_warning_pct,
        alert_cpu_critical_pct=alert_cpu_critical_pct,
        alert_memory_warning_pct=alert_memory_warning_pct,
        alert_memory_critical_pct=alert_memory_critical_pct,
        alert_disk_warning_pct=alert_disk_warning_pct,
        alert_disk_critical_pct=alert_disk_critical_pct,
        alert_workflow_failure_threshold=alert_workflow_failure_threshold,
        alert_rate_limit_warning_pct=alert_rate_limit_warning_pct,
        alert_rate_limit_critical_pct=alert_rate_limit_critical_pct,
        alert_sync_lag_warning_commits=alert_sync_lag_warning_commits,
        alert_sync_lag_critical_commits=alert_sync_lag_critical_commits,
        alert_actions_delay_warning_seconds=alert_actions_delay_warning_seconds,
        alert_actions_delay_critical_seconds=alert_actions_delay_critical_seconds,
    )
