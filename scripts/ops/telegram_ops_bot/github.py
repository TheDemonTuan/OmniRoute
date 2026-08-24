"""GitHub App authentication, token minting/caching, and REST client.

Implements GitHub App JWT signing via OpenSSL CLI subprocess (using safe argument arrays),
installation token minting with caching, and a robust REST client with rate limiting,
pagination, typed error handling, and sensitive data redaction. Python 3.9 stdlib only.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple, Union

# Sensitive data patterns for redaction
_TOKEN_PATTERNS = [
    re.compile(r"ghp_[A-Za-z0-9_]{20,}", re.ASCII),
    re.compile(r"ghs_[A-Za-z0-9_]{20,}", re.ASCII),
    re.compile(r"gho_[A-Za-z0-9_]{20,}", re.ASCII),
    re.compile(r"ghu_[A-Za-z0-9_]{20,}", re.ASCII),
    re.compile(r"ghr_[A-Za-z0-9_]{20,}", re.ASCII),
    re.compile(r"github_pat_[A-Za-z0-9_]{22,}", re.ASCII),
    re.compile(r"(?i)\bbearer\s+([A-Za-z0-9_\-\.]+)", re.ASCII),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----", re.ASCII),
]


def redact_sensitive(text: str) -> str:
    """Redact GitHub tokens, Bearer headers, and private keys from strings."""
    if not isinstance(text, str):
        text = str(text)

    # Redact private keys
    text = re.sub(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]",
        text,
    )
    # Redact Bearer tokens
    text = re.sub(r"(?i)\bbearer\s+[A-Za-z0-9_\-\.]+", "Bearer [REDACTED]", text)
    # Redact known GitHub token prefixes
    text = re.sub(r"gh[psour]_[A-Za-z0-9_]{20,}", "[REDACTED TOKEN]", text)
    text = re.sub(r"github_pat_[A-Za-z0-9_]{22,}", "[REDACTED TOKEN]", text)
    return text


def b64url_encode(data: bytes) -> str:
    """Encode bytes to base64url string without trailing padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(data: str) -> bytes:
    """Decode base64url string, adding required padding if necessary."""
    rem = len(data) % 4
    if rem > 0:
        data += "=" * (4 - rem)
    return base64.urlsafe_b64decode(data.encode("ascii"))


def parse_iso8601_timestamp(iso_str: str) -> float:
    """Parse ISO8601 string to unix timestamp (supports trailing 'Z')."""
    cleaned = iso_str.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(cleaned)
    return dt.timestamp()


class _NotModified:
    """Marker returned instead of a body when GitHub answers 304 Not Modified.

    A conditional request that hits an unchanged resource costs no GitHub rate
    limit quota at all, which is the whole point of sending If-None-Match on
    the polls the alert loop makes every cycle.
    """

    def __repr__(self) -> str:
        return "NOT_MODIFIED"

    def __bool__(self) -> bool:
        return False


NOT_MODIFIED = _NotModified()


class GitHubError(Exception):
    """Base exception for GitHub API errors with automatic redaction."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        response_data: Optional[Any] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> None:
        self.raw_message = message
        self.message = redact_sensitive(message)
        self.status_code = status_code
        self.response_data = response_data
        self.headers = headers or {}
        super().__init__(self.message)

    def __str__(self) -> str:
        code_part = f" [HTTP {self.status_code}]" if self.status_code else ""
        return f"{self.message}{code_part}"


class GitHubAuthError(GitHubError):
    """Raised on authentication failures (401 or bad credentials/keys)."""


class GitHubPermissionError(GitHubError):
    """Raised on permission/authorization failures (403 forbidden)."""


class GitHubNotFoundError(GitHubError):
    """Raised when the requested resource is not found (404)."""


class GitHubRateLimitError(GitHubError):
    """Raised when GitHub rate limit is exceeded (403/429)."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        response_data: Optional[Any] = None,
        headers: Optional[Dict[str, str]] = None,
        reset_timestamp: Optional[int] = None,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message, status_code, response_data, headers)
        self.reset_timestamp = reset_timestamp
        self.retry_after = retry_after


class GitHubValidationError(GitHubError):
    """Raised when GitHub returns 422 Unprocessable Entity."""


@dataclass
class RateLimitInfo:
    """Tracks GitHub API rate limit state."""

    limit: int = 5000
    remaining: int = 5000
    reset_timestamp: int = 0
    used: int = 0
    retry_after: Optional[int] = None

    @classmethod
    def from_headers(cls, headers: Dict[str, str]) -> RateLimitInfo:
        # Case-insensitive header dictionary lookup
        h_lower = {k.lower(): v for k, v in headers.items()}

        limit = int(h_lower.get("x-ratelimit-limit", "5000"))
        remaining = int(h_lower.get("x-ratelimit-remaining", "5000"))
        reset_ts = int(h_lower.get("x-ratelimit-reset", "0"))
        used = int(h_lower.get("x-ratelimit-used", "0"))
        retry_after = None
        if "retry-after" in h_lower:
            try:
                retry_after = int(h_lower["retry-after"])
            except ValueError:
                pass

        return cls(
            limit=limit,
            remaining=remaining,
            reset_timestamp=reset_ts,
            used=used,
            retry_after=retry_after,
        )


@dataclass
class CachedInstallationToken:
    """Cached installation token with expiration tracking."""

    token: str
    expires_at_timestamp: float
    permissions: Dict[str, Any] = field(default_factory=dict)
    repository_selection: Optional[str] = None

    def is_valid(self, buffer_seconds: float = 300.0) -> bool:
        """Check if token is valid and not within the expiration buffer."""
        return time.time() < (self.expires_at_timestamp - buffer_seconds)


def generate_jwt(
    app_id: Union[str, int],
    private_key: str,
    expiration_seconds: int = 600,
) -> str:
    """Generate a signed GitHub App JWT using OpenSSL CLI.

    Args:
        app_id: GitHub App ID.
        private_key: RSA private key as PEM text or path to PEM file.
        expiration_seconds: JWT lifetime in seconds (max 600s / 10m).

    Returns:
        Signed JWT string.
    """
    if expiration_seconds > 600:
        expiration_seconds = 600

    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    payload = {
        "iat": now - 60,  # 60s in the past to prevent clock drift issues
        "exp": now + expiration_seconds,
        "iss": str(app_id),
    }

    header_b64 = b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_b64 = b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    data_to_sign = f"{header_b64}.{payload_b64}".encode("ascii")

    temp_path: Optional[str] = None
    if os.path.isfile(private_key):
        key_path = private_key
    else:
        # Securely write PEM string to a temporary file
        fd, temp_path = tempfile.mkstemp(prefix="gh_jwt_key_", suffix=".pem")
        try:
            os.chmod(temp_path, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(private_key.strip() + "\n")
            key_path = temp_path
        except Exception as e:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)
            raise GitHubAuthError(f"Failed to prepare private key for signing: {e}")

    try:
        # Safely invoke OpenSSL using argument array
        cmd = ["openssl", "dgst", "-sha256", "-sign", key_path]
        proc = subprocess.run(
            cmd,
            input=data_to_sign,
            capture_output=True,
            check=False,
        )
        if proc.returncode != 0:
            err_msg = proc.stderr.decode("utf-8", errors="replace")
            raise GitHubAuthError(f"OpenSSL failed to sign JWT: {err_msg}")

        sig_b64 = b64url_encode(proc.stdout)
        return f"{header_b64}.{payload_b64}.{sig_b64}"
    except FileNotFoundError:
        raise GitHubAuthError("OpenSSL binary not found on system PATH.")
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass


class GitHubClient:
    """REST Client for GitHub API with App & PAT authentication, pagination, and error handling."""

    def __init__(
        self,
        token: Optional[str] = None,
        app_id: Optional[Union[str, int]] = None,
        private_key: Optional[str] = None,
        installation_id: Optional[Union[str, int]] = None,
        base_url: str = "https://api.github.com",
        timeout: float = 30.0,
        token_buffer_seconds: float = 300.0,
        opener: Optional[Callable[..., Any]] = None,
    ) -> None:
        self.token = token
        self.app_id = app_id
        self.private_key = private_key
        self.installation_id = installation_id
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.token_buffer_seconds = token_buffer_seconds
        self._cached_token: Optional[CachedInstallationToken] = None
        self._last_rate_limit: Optional[RateLimitInfo] = None
        self._last_etag: Optional[str] = None
        self._opener = opener or urllib.request.urlopen

    def get_rate_limit_info(self) -> Optional[RateLimitInfo]:
        """Return the most recent rate limit info."""
        return self._last_rate_limit

    def mint_installation_token(self, force_refresh: bool = False) -> str:
        """Mint or fetch a cached GitHub App installation access token."""
        if not self.app_id or not self.private_key or not self.installation_id:
            raise GitHubAuthError("App ID, private key, and installation ID are required to mint token.")

        if (
            not force_refresh
            and self._cached_token
            and self._cached_token.is_valid(buffer_seconds=self.token_buffer_seconds)
        ):
            return self._cached_token.token

        jwt_token = generate_jwt(
            app_id=self.app_id,
            private_key=self.private_key,
            expiration_seconds=600,
        )

        url = f"{self.base_url}/app/installations/{self.installation_id}/access_tokens"
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {jwt_token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "OmniRoute-Ops-Bot",
            "Content-Type": "application/json",
        }

        req = urllib.request.Request(url, data=b"{}", headers=headers, method="POST")
        try:
            with self._opener(req, timeout=self.timeout) as resp:
                resp_bytes = resp.read()
                data = json.loads(resp_bytes.decode("utf-8"))
                token_val = data.get("token")
                expires_at_str = data.get("expires_at")
                if not token_val or not expires_at_str:
                    raise GitHubAuthError("Invalid installation token response from GitHub.")

                exp_ts = parse_iso8601_timestamp(expires_at_str)
                self._cached_token = CachedInstallationToken(
                    token=token_val,
                    expires_at_timestamp=exp_ts,
                    permissions=data.get("permissions", {}),
                    repository_selection=data.get("repository_selection"),
                )
                return token_val
        except urllib.error.HTTPError as e:
            raw_err = e.read().decode("utf-8", errors="replace")
            raise GitHubAuthError(
                f"Failed to mint installation token: HTTP {e.code} - {raw_err}",
                status_code=e.code,
            )
        except Exception as e:
            raise GitHubAuthError(f"Failed to mint installation token: {e}")

    def get_auth_token(self) -> Optional[str]:
        """Get the current active authentication token."""
        if self.token:
            return self.token
        if self.app_id and self.private_key and self.installation_id:
            return self.mint_installation_token()
        return None

    def request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Any] = None,
        headers: Optional[Dict[str, str]] = None,
        raw_response: bool = False,
        etag: Optional[str] = None,
    ) -> Any:
        """Execute an HTTP request against the GitHub REST API.

        Args:
            method: HTTP method (GET, POST, PUT, DELETE, PATCH).
            path: API path (e.g. '/repos/owner/repo') or absolute URL.
            params: Optional query parameters dictionary.
            json_data: Optional JSON serializable body payload.
            headers: Optional additional request headers.
            raw_response: If True, returns decoded raw text/bytes instead of parsed JSON.
            etag: If given, sent as If-None-Match; an unchanged resource then
                returns the NOT_MODIFIED sentinel instead of a body.

        Returns:
            Parsed JSON dict/list, raw data, empty dict for 204 No Content, or
            NOT_MODIFIED when a conditional request matched.
        """
        method = method.upper()
        if path.startswith("http://") or path.startswith("https://"):
            full_url = path
        else:
            clean_path = path if path.startswith("/") else f"/{path}"
            full_url = f"{self.base_url}{clean_path}"

        if params:
            # Filter out None values and encode
            query_items = [(k, v) for k, v in params.items() if v is not None]
            if query_items:
                sep = "&" if "?" in full_url else "?"
                full_url += sep + urllib.parse.urlencode(query_items)

        req_headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "OmniRoute-Ops-Bot",
        }

        auth_token = self.get_auth_token()
        if auth_token:
            req_headers["Authorization"] = f"Bearer {auth_token}"

        body_bytes: Optional[bytes] = None
        if json_data is not None:
            body_bytes = json.dumps(json_data).encode("utf-8")
            req_headers["Content-Type"] = "application/json"

        if etag:
            req_headers["If-None-Match"] = etag

        if headers:
            req_headers.update(headers)

        req = urllib.request.Request(full_url, data=body_bytes, headers=req_headers, method=method)

        try:
            with self._opener(req, timeout=self.timeout) as resp:
                resp_headers = dict(resp.headers.items()) if hasattr(resp, "headers") else {}
                self._last_rate_limit = RateLimitInfo.from_headers(resp_headers)
                self._last_etag = next(
                    (v for k, v in resp_headers.items() if k.lower() == "etag"), None
                )

                status_code = getattr(resp, "status", getattr(resp, "code", 200))
                if status_code == 204:
                    return {}

                body = resp.read()
                if raw_response:
                    return body.decode("utf-8", errors="replace")

                if not body:
                    return {}

                try:
                    return json.loads(body.decode("utf-8"))
                except json.JSONDecodeError:
                    return body.decode("utf-8", errors="replace")

        except urllib.error.HTTPError as e:
            resp_headers = dict(e.headers.items()) if hasattr(e, "headers") else {}
            self._last_rate_limit = RateLimitInfo.from_headers(resp_headers)

            if e.code == 304:
                # Conditional hit: the caller still holds a valid cached copy,
                # and GitHub charged us nothing for asking.
                return NOT_MODIFIED

            err_body = e.read().decode("utf-8", errors="replace")
            parsed_err: Optional[Any] = None
            err_msg = f"HTTP {e.code}"
            try:
                parsed_err = json.loads(err_body)
                if isinstance(parsed_err, dict) and "message" in parsed_err:
                    err_msg = f"HTTP {e.code}: {parsed_err['message']}"
            except Exception:
                if err_body:
                    err_msg = f"HTTP {e.code}: {err_body[:200]}"

            # Handle rate limit specifics
            if e.code == 403 and (
                "rate limit" in err_msg.lower()
                or self._last_rate_limit.remaining == 0
                or "x-ratelimit-remaining" in {k.lower(): v for k, v in resp_headers.items()}
            ):
                raise GitHubRateLimitError(
                    message=f"Rate limit exceeded: {err_msg}",
                    status_code=e.code,
                    response_data=parsed_err,
                    headers=resp_headers,
                    reset_timestamp=self._last_rate_limit.reset_timestamp,
                    retry_after=self._last_rate_limit.retry_after,
                )
            elif e.code == 429:
                raise GitHubRateLimitError(
                    message=f"Too many requests: {err_msg}",
                    status_code=e.code,
                    response_data=parsed_err,
                    headers=resp_headers,
                    reset_timestamp=self._last_rate_limit.reset_timestamp,
                    retry_after=self._last_rate_limit.retry_after,
                )
            elif e.code == 401:
                raise GitHubAuthError(
                    message=f"Unauthorized: {err_msg}",
                    status_code=e.code,
                    response_data=parsed_err,
                    headers=resp_headers,
                )
            elif e.code == 403:
                raise GitHubPermissionError(
                    message=f"Forbidden: {err_msg}",
                    status_code=e.code,
                    response_data=parsed_err,
                    headers=resp_headers,
                )
            elif e.code == 404:
                raise GitHubNotFoundError(
                    message=f"Not Found: {err_msg}",
                    status_code=e.code,
                    response_data=parsed_err,
                    headers=resp_headers,
                )
            elif e.code == 422:
                raise GitHubValidationError(
                    message=f"Validation failed: {err_msg}",
                    status_code=e.code,
                    response_data=parsed_err,
                    headers=resp_headers,
                )
            else:
                raise GitHubError(
                    message=f"GitHub API Error: {err_msg}",
                    status_code=e.code,
                    response_data=parsed_err,
                    headers=resp_headers,
                )
        except urllib.error.URLError as e:
            raise GitHubError(f"Network error communicating with GitHub: {e.reason}")
        except GitHubError:
            raise
        except Exception as e:
            raise GitHubError(f"Unexpected error communicating with GitHub: {e}")

    def get(
        self,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        etag: Optional[str] = None,
    ) -> Any:
        """Execute a GET request."""
        return self.request("GET", path, params=params, headers=headers, etag=etag)

    @property
    def last_etag(self) -> Optional[str]:
        """ETag of the most recent successful response, for conditional re-reads."""
        return self._last_etag

    def post(
        self,
        path: str,
        json_data: Optional[Any] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        """Execute a POST request."""
        return self.request("POST", path, json_data=json_data, headers=headers)

    def put(
        self,
        path: str,
        json_data: Optional[Any] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        """Execute a PUT request."""
        return self.request("PUT", path, json_data=json_data, headers=headers)

    def patch(
        self,
        path: str,
        json_data: Optional[Any] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        """Execute a PATCH request."""
        return self.request("PATCH", path, json_data=json_data, headers=headers)

    def delete(self, path: str, headers: Optional[Dict[str, str]] = None) -> Any:
        """Execute a DELETE request."""
        return self.request("DELETE", path, headers=headers)

    def paginate(
        self,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        max_pages: Optional[int] = None,
        per_page: int = 100,
    ) -> Iterator[Any]:
        """Iterate over paginated items returned by a GitHub API endpoint.

        Args:
            path: API path.
            params: Optional query params.
            max_pages: Maximum number of pages to fetch (None for all).
            per_page: Items per page (max 100).

        Yields:
            Individual items from array responses or paginated keys (e.g. 'items', 'workflow_runs').
        """
        current_page = 1
        page_params = dict(params or {})
        page_params["per_page"] = per_page

        while True:
            if max_pages is not None and current_page > max_pages:
                break

            page_params["page"] = current_page
            result = self.get(path, params=page_params)

            items_to_yield: List[Any] = []
            if isinstance(result, list):
                items_to_yield = result
            elif isinstance(result, dict):
                # Check for common wrapper keys
                for key in (
                    "items",
                    "workflow_runs",
                    "jobs",
                    "branches",
                    "commits",
                    "pull_requests",
                    "check_runs",
                ):
                    if key in result and isinstance(result[key], list):
                        items_to_yield = result[key]
                        break
                if not items_to_yield and not any(k in result for k in ("total_count", "items")):
                    yield result
                    break

            if not items_to_yield:
                break

            for item in items_to_yield:
                yield item

            if len(items_to_yield) < per_page:
                break

            current_page += 1

    def list_all(
        self,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        max_pages: Optional[int] = None,
        per_page: int = 100,
    ) -> List[Any]:
        """Fetch all items across pages into a flat list."""
        return list(self.paginate(path, params=params, max_pages=max_pages, per_page=per_page))
