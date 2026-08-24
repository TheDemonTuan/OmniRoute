"""Telegram Ops Bot for OmniRoute operations monitoring and management.

Python 3.9+ standard library only.
"""

from .commands import CommandDispatcher
from .config import BotConfig, load_config_from_env
from .main import TelegramOpsBot, main
from .metrics import (
    BackupInfo,
    ContainerInfo,
    DeployInfo,
    GitHubClient,
    GitHubClientProtocol,
    HostMetrics,
    MetricsCollector,
    OmniRouteInfo,
    SecurityMetrics,
)
from .security import (
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
from .state import StateManager
from .telegram import (
    InlineKeyboardButton,
    TelegramAPIError,
    TelegramClient,
    TelegramError,
    TelegramNetworkError,
    TelegramRateLimitError,
    TelegramUnauthorizedError,
    make_inline_keyboard,
)

__all__ = [
    "BotConfig",
    "load_config_from_env",
    "TelegramOpsBot",
    "main",
    "StateManager",
    "TelegramClient",
    "TelegramError",
    "TelegramAPIError",
    "TelegramNetworkError",
    "TelegramRateLimitError",
    "TelegramUnauthorizedError",
    "InlineKeyboardButton",
    "make_inline_keyboard",
    "MetricsCollector",
    "GitHubClient",
    "GitHubClientProtocol",
    "HostMetrics",
    "ContainerInfo",
    "OmniRouteInfo",
    "DeployInfo",
    "BackupInfo",
    "SecurityMetrics",
    "CommandDispatcher",
    "hash_pin",
    "verify_pin",
    "generate_nonce",
    "redact_sensitive",
    "truncate_message",
    "chunk_message",
    "escape_html",
    "escape_markdown_v2",
    "is_user_authorized",
    "is_chat_authorized",
    "check_access",
]
