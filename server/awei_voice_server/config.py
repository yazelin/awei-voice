"""Configuration for exact browser-origin access to the voice API."""

from __future__ import annotations

from dataclasses import dataclass
import os
import re
from urllib.parse import urlsplit


LOCAL_WEB_ORIGIN_PATTERN = (
    r"^https?://(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$"
)
_LOCAL_WEB_ORIGIN_RE = re.compile(LOCAL_WEB_ORIGIN_PATTERN)


def _get_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean")


def _validate_configured_origin(origin: str) -> str:
    if "*" in origin:
        raise ValueError("AWEI_ALLOWED_WEB_ORIGINS must never contain '*'")
    parsed = urlsplit(origin)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(
            f"invalid web origin {origin!r}: expected scheme and host"
        )
    if parsed.username or parsed.password:
        raise ValueError(f"invalid web origin {origin!r}: credentials are forbidden")
    if parsed.path or parsed.query or parsed.fragment:
        raise ValueError(
            f"invalid web origin {origin!r}: paths, queries, and fragments are forbidden"
        )
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError(f"invalid web origin {origin!r}: invalid port") from exc

    is_local = parsed.hostname in {"localhost", "127.0.0.1"}
    if parsed.scheme != "https" and not is_local:
        raise ValueError(
            f"invalid web origin {origin!r}: non-local origins must use HTTPS"
        )
    return origin


@dataclass(frozen=True, slots=True)
class WebSettings:
    """The only browser origins that may call through this wrapper."""

    allowed_web_origins: tuple[str, ...] = ()
    allow_localhost_origins: bool = True

    def __post_init__(self) -> None:
        validated = tuple(
            _validate_configured_origin(origin)
            for origin in self.allowed_web_origins
        )
        if len(validated) != len(set(validated)):
            raise ValueError("AWEI_ALLOWED_WEB_ORIGINS must not contain duplicates")

    @classmethod
    def from_env(cls) -> "WebSettings":
        origins = tuple(
            value.strip()
            for value in os.getenv("AWEI_ALLOWED_WEB_ORIGINS", "").split(",")
            if value.strip()
        )
        return cls(
            allowed_web_origins=origins,
            allow_localhost_origins=_get_bool(
                "AWEI_ALLOW_LOCALHOST_ORIGINS", True
            ),
        )

    def origin_is_allowed(self, origin: str) -> bool:
        if origin in self.allowed_web_origins:
            return True
        return self.allow_localhost_origins and bool(
            _LOCAL_WEB_ORIGIN_RE.fullmatch(origin)
        )
