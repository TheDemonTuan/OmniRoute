"""Security and cryptography utilities for Telegram Ops Bot.

Includes scrypt PIN hashing/verification, nonce generation, allowlist checks,
strict sensitive data redaction, and Telegram message truncation/chunking.
Uses Python standard library only.
"""

import hashlib
import hmac
import html
import re
import secrets
from typing import List, Optional, Set, Tuple


SENSITIVE_PATTERNS = [
    # Telegram bot tokens (e.g., 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ)
    (re.compile(r"\b\d{6,14}:[A-Za-z0-9_\-]{30,50}\b"), "[REDACTED_BOT_TOKEN]"),
    # Private RSA/EC/OPENSSH/PGP Keys
    (
        re.compile(r"-----BEGIN [A-Z0-9_\- ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9_\- ]+PRIVATE KEY-----"),
        "[REDACTED_PRIVATE_KEY]",
    ),
    # JWT tokens
    (
        re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+\b"),
        "[REDACTED_JWT]",
    ),
    # Bearer tokens in headers or logs
    (
        re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9\-_.~+/=]{16,}\b"),
        r"\1[REDACTED_BEARER]",
    ),
    # Common API key prefix formats (OpenAI, Anthropic, GitHub, AWS, etc.)
    (re.compile(r"\bsk-(?:live|proj|svc)?[a-zA-Z0-9]{20,}\b"), "sk-[REDACTED]"),
    (re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b"), "gh_[REDACTED]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AKIA[REDACTED]"),
    # Passwords in URLs (e.g. postgres://user:pass@host, http://user:pass@host)
    (re.compile(r"([a-zA-Z][a-zA-Z0-9+\-.]*://[^:\s/]+:)([^@\s/]+)(@)"), r"\1[REDACTED_PASS]\3"),
    # Generic key/secret assignments in config, JSON, or env dumps
    (
        re.compile(
            r"(?i)(api[_\-]?key|secret(?:[_\-]?key)?|password|passwd|auth[_\-]?token|access[_\-]?token|private[_\-]?key|credentials?)"
            r"(\s*[:=]\s*[\"']?)"
            r"([^\"'\s\n,;}{]{4,})"
            r"([\"']?)"
        ),
        r"\1\2[REDACTED]\4",
    ),
]


def hash_pin(
    pin: str,
    salt: Optional[bytes] = None,
    n: int = 16384,
    r: int = 8,
    p: int = 1,
    maxmem: int = 0,
) -> Tuple[str, str]:
    """Generate scrypt hash for a PIN or secret.

    Returns:
        Tuple of (hash_hex, salt_hex)
    """
    if not salt:
        salt = secrets.token_bytes(16)
    pin_bytes = pin.encode("utf-8")
    derived = hashlib.scrypt(
        pin_bytes,
        salt=salt,
        n=n,
        r=r,
        p=p,
        maxmem=maxmem,
        dklen=64,
    )
    return derived.hex(), salt.hex()


def verify_pin(
    pin: str,
    expected_hash_hex: str,
    salt_hex: str,
    n: int = 16384,
    r: int = 8,
    p: int = 1,
    maxmem: int = 0,
) -> bool:
    """Verify PIN against an expected scrypt hash in constant time."""
    if not pin or not expected_hash_hex or not salt_hex:
        return False
    try:
        salt_bytes = bytes.fromhex(salt_hex)
        derived = hashlib.scrypt(
            pin.encode("utf-8"),
            salt=salt_bytes,
            n=n,
            r=r,
            p=p,
            maxmem=maxmem,
            dklen=64,
        )
        return hmac.compare_digest(derived.hex().lower(), expected_hash_hex.lower().strip())
    except (ValueError, TypeError):
        return False


def generate_nonce(nbytes: int = 16) -> str:
    """Generate a secure cryptographic one-time hex nonce."""
    return secrets.token_hex(nbytes)


def redact_sensitive(text: str) -> str:
    """Redact tokens, credentials, keys, and passwords from string."""
    if not text:
        return ""
    redacted = text
    for pattern, repl in SENSITIVE_PATTERNS:
        redacted = pattern.sub(repl, redacted)
    return redacted


def truncate_message(text: str, max_length: int = 4096, suffix: str = "\n\n...[truncated]") -> str:
    """Truncate text to fit within Telegram's max message length."""
    if not text:
        return ""
    if len(text) <= max_length:
        return text
    cutoff = max_length - len(suffix)
    if cutoff <= 0:
        return text[:max_length]
    return text[:cutoff] + suffix


def chunk_message(text: str, chunk_size: int = 4000) -> List[str]:
    """Split long text into chunks of at most chunk_size characters, breaking on newlines where possible."""
    if not text:
        return [""]
    if len(text) <= chunk_size:
        return [text]

    chunks: List[str] = []
    remaining = text

    while len(remaining) > chunk_size:
        # Search for newline within the chunk_size boundary
        split_idx = remaining.rfind("\n", 0, chunk_size)
        if split_idx == -1 or split_idx < chunk_size // 2:
            # Fall back to space
            split_idx = remaining.rfind(" ", 0, chunk_size)
        if split_idx == -1 or split_idx < chunk_size // 4:
            # Hard split
            split_idx = chunk_size

        chunk = remaining[:split_idx].rstrip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[split_idx:].lstrip("\r\n")

    if remaining:
        chunks.append(remaining)

    return chunks


def escape_html(text: str) -> str:
    """Escape special HTML characters for Telegram HTML parse_mode."""
    if not text:
        return ""
    return html.escape(text, quote=False)


def escape_markdown_v2(text: str) -> str:
    """Escape Telegram MarkdownV2 special characters."""
    if not text:
        return ""
    escape_chars = r"_*[]()~`>#+-=|{}.!"
    return re.sub(f"([{re.escape(escape_chars)}])", r"\\\1", text)


def is_user_authorized(user_id: Optional[int], allowed_user_ids: Set[int]) -> bool:
    """Check if user_id is in allowed users set."""
    if user_id is None or not allowed_user_ids:
        return False
    return user_id in allowed_user_ids


def is_chat_authorized(
    chat_id: Optional[int],
    allowed_chat_ids: Set[int],
    chat_type: Optional[str] = None,
    require_private_chat: bool = True,
) -> bool:
    """Check if chat is allowed and matches privacy requirements."""
    if chat_id is None:
        return False
    if require_private_chat and chat_type is not None and chat_type != "private":
        return False
    if allowed_chat_ids and chat_id not in allowed_chat_ids:
        return False
    return True


def check_access(
    user_id: Optional[int],
    chat_id: Optional[int],
    chat_type: Optional[str],
    allowed_user_ids: Set[int],
    allowed_chat_ids: Set[int],
    require_private_chat: bool = True,
) -> Tuple[bool, Optional[str]]:
    """Comprehensive authorization gate.

    Returns:
        Tuple[bool, Optional[str]]: (is_authorized, denial_reason)
    """
    if user_id is None:
        return False, "Missing user ID"
    if chat_id is None:
        return False, "Missing chat ID"

    if not is_user_authorized(user_id, allowed_user_ids):
        return False, f"User {user_id} is not in the authorized users list."

    if require_private_chat and chat_type != "private":
        return False, "This bot only accepts commands in private 1:1 direct messages."

    if allowed_chat_ids and not is_chat_authorized(chat_id, allowed_chat_ids, chat_type, require_private_chat):
        return False, f"Chat {chat_id} is not authorized."

    return True, None
