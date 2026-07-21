"""ASGI entry point with web-specific CORS around the pinned backend."""

from __future__ import annotations

from dataclasses import replace
import os
from unittest.mock import patch

from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from taigi_news_reader_backend.app import create_app as create_upstream_app
from taigi_news_reader_backend.config import Settings as UpstreamSettings

from .config import LOCAL_WEB_ORIGIN_PATTERN, WebSettings


class WebOriginGateMiddleware:
    """Reject browser calls from origins not named by the deployment.

    CORS response headers alone are not an authorization boundary. This gate
    therefore rejects a supplied, untrusted Origin before it reaches upstream.
    Deployments may additionally require Origin on every /v1/ request. Health
    tooling remains origin-free; a supplied Origin is always checked exactly.
    Bearer authentication remains available when upstream access controls are
    enabled, but the public web deployment instead combines this gate with
    durable anonymous quota and edge per-IP limits.
    """

    def __init__(self, app: ASGIApp, *, settings: WebSettings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if scope["type"] == "http":
            headers = dict(scope.get("headers", ()))
            raw_origin = headers.get(b"origin")
            if (
                raw_origin is None
                and self.settings.require_web_origin
                and scope.get("path", "").startswith("/v1/")
            ):
                response = JSONResponse(
                    status_code=403,
                    content={"detail": "request web origin is required"},
                    headers={"Cache-Control": "no-store"},
                )
                await response(scope, receive, send)
                return
            if raw_origin is not None:
                try:
                    origin = raw_origin.decode("ascii")
                except UnicodeDecodeError:
                    origin = ""
                if not self.settings.origin_is_allowed(origin):
                    response = JSONResponse(
                        status_code=403,
                        content={"detail": "request web origin is not allowed"},
                        headers={"Cache-Control": "no-store"},
                    )
                    await response(scope, receive, send)
                    return
        await self.app(scope, receive, send)


def _web_upstream_settings(
    settings: UpstreamSettings | None,
) -> UpstreamSettings:
    if settings is None:
        # Ignore legacy extension-only switches before upstream validation, not
        # merely afterward. This keeps a reused shell environment from making
        # the web service demand an extension ID it intentionally does not use.
        with patch.dict(
            os.environ,
            {
                "TAIGI_EXTENSION_IDS": "",
                "TAIGI_ALLOW_LOCALHOST_ORIGINS": "false",
                "TAIGI_REQUIRE_ALLOWED_ORIGIN": "false",
            },
        ):
            base = UpstreamSettings.from_env()
    else:
        base = settings
    # The dependency was built for a Chrome extension. The outer wrapper owns
    # browser identity now, so no extension ID/header is accepted or required.
    # The web client intentionally uses only the async job contract.
    return replace(
        base,
        extension_ids=(),
        allow_localhost_origins=False,
        require_allowed_origin=False,
        # Public web use may be token-free, but it is never unmetered. The
        # shared open-access subject is still admitted atomically through the
        # durable SQLite subject/global quota store.
        enforce_open_access_quota=True,
        mandarin_tts_provider="edge",
        allow_direct_synthesis=False,
    )


def create_app(
    web_settings: WebSettings | None = None,
    upstream_settings: UpstreamSettings | None = None,
) -> ASGIApp:
    """Build the web-origin wrapper without loading or downloading TTS models."""

    web_settings = web_settings or WebSettings.from_env()
    upstream = create_upstream_app(
        settings=_web_upstream_settings(upstream_settings)
    )
    gated: ASGIApp = WebOriginGateMiddleware(upstream, settings=web_settings)
    return CORSMiddleware(
        gated,
        allow_origins=list(web_settings.allowed_web_origins),
        allow_origin_regex=(
            LOCAL_WEB_ORIGIN_PATTERN
            if web_settings.allow_localhost_origins
            else None
        ),
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        expose_headers=[
            "Retry-After",
            "X-RateLimit-Reset",
            "X-RateLimit-Remaining",
            "X-RateLimit-Scope",
        ],
        max_age=600,
    )
