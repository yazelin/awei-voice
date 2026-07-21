from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import httpx
import pytest
from taigi_news_reader_backend.config import AccessTokenHash, Settings

from awei_voice_server.app import create_app
from awei_voice_server.config import WebSettings


pytestmark = pytest.mark.asyncio


REQUEST = {
    "text": "今天天氣真好。",
    "source_language": "zh-TW",
    "target_language": "nan-TW",
    "rate": 1.0,
}
WEB_ORIGIN = "https://voice.example.test"


async def request(app, method: str, path: str, **kwargs) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://backend.test",
    ) as client:
        return await client.request(method, path, **kwargs)


def mock_app(*, localhost: bool = True):
    return create_app(
        WebSettings(
            allowed_web_origins=(WEB_ORIGIN,),
            allow_localhost_origins=localhost,
        ),
        Settings(provider_mode="mock"),
    )


@pytest.mark.parametrize(
    "origin",
    [
        "*",
        "https://*.example.test",
        "https://voice.example.test/path",
        "http://remote.example.test",
    ],
)
async def test_origin_configuration_fails_closed(origin: str):
    with pytest.raises(ValueError):
        WebSettings(allowed_web_origins=(origin,))


async def test_health_is_mock_and_does_not_load_a_model():
    app = mock_app()
    response = await request(
        app,
        "GET",
        "/health",
        headers={"Origin": WEB_ORIGIN},
    )
    old_extension_origin = await request(
        app,
        "GET",
        "/health",
        headers={"Origin": f"chrome-extension://{'a' * 32}"},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == WEB_ORIGIN
    assert response.json() == {
        "status": "ok",
        "mode": "mock",
        "translator": "mock:taigi-translator",
        "synthesizer": "mock:wav-synthesizer",
    }
    assert old_extension_origin.status_code == 403
    assert "access-control-allow-origin" not in old_extension_origin.headers


async def test_configured_web_origin_can_use_async_jobs_without_extension_id():
    app = mock_app()
    preflight = await request(
        app,
        "OPTIONS",
        "/v1/synthesis-jobs",
        headers={
            "Origin": WEB_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    created = await request(
        app,
        "POST",
        "/v1/synthesis-jobs",
        headers={"Origin": WEB_ORIGIN},
        json=REQUEST,
    )

    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == WEB_ORIGIN
    assert "authorization" in preflight.headers[
        "access-control-allow-headers"
    ].lower()
    assert created.status_code == 202
    assert created.headers["access-control-allow-origin"] == WEB_ORIGIN
    assert created.json()["status"] == "pending"

    deleted = await request(
        app,
        "DELETE",
        f"/v1/synthesis-jobs/{created.json()['job_id']}",
        headers={"Origin": WEB_ORIGIN},
    )
    assert deleted.status_code == 204


async def test_legacy_extension_environment_is_ignored(monkeypatch):
    monkeypatch.setenv("TAIGI_PROVIDER_MODE", "mock")
    monkeypatch.setenv("TAIGI_EXTENSION_IDS", "not-an-extension-id")
    monkeypatch.setenv("TAIGI_REQUIRE_ALLOWED_ORIGIN", "true")

    app = create_app(WebSettings(allowed_web_origins=(WEB_ORIGIN,)))
    response = await request(
        app,
        "GET",
        "/health",
        headers={"Origin": WEB_ORIGIN},
    )

    assert response.status_code == 200
    assert response.json()["mode"] == "mock"


async def test_async_job_poll_and_terminal_result_contract_is_preserved():
    app = mock_app()
    headers = {"Origin": WEB_ORIGIN}
    created = await request(
        app,
        "POST",
        "/v1/synthesis-jobs",
        headers=headers,
        json=REQUEST,
    )
    job_id = created.json()["job_id"]

    terminal = None
    for _ in range(20):
        response = await request(
            app,
            "GET",
            f"/v1/synthesis-jobs/{job_id}",
            headers=headers,
        )
        if response.json()["status"] != "pending":
            terminal = response
            break
        await asyncio.sleep(0)

    assert terminal is not None
    body = terminal.json()
    assert body["status"] == "completed"
    assert body["result"]["mime_type"] == "audio/wav"
    assert body["result"]["taigi_text"]
    assert body["result"]["audio_base64"]
    assert body["result"]["provider"] == (
        "mock:taigi-translator+mock:wav-synthesizer"
    )

    deleted = await request(
        app,
        "DELETE",
        f"/v1/synthesis-jobs/{job_id}",
        headers=headers,
    )
    assert deleted.status_code == 204


async def test_localhost_origin_is_allowed_but_unlisted_remote_origin_is_rejected():
    app = mock_app()
    local = await request(
        app,
        "GET",
        "/v1/access",
        headers={"Origin": "http://localhost:5173"},
    )
    rejected = await request(
        app,
        "GET",
        "/v1/access",
        headers={"Origin": "https://evil.example"},
    )
    rejected_preflight = await request(
        app,
        "OPTIONS",
        "/v1/synthesis-jobs",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert local.status_code == 200
    assert local.headers["access-control-allow-origin"] == (
        "http://localhost:5173"
    )
    assert rejected.status_code == 403
    assert rejected.json() == {"detail": "request web origin is not allowed"}
    assert "access-control-allow-origin" not in rejected.headers
    assert rejected_preflight.status_code == 400
    assert "access-control-allow-origin" not in rejected_preflight.headers


async def test_bearer_authorization_reaches_the_upstream_access_control(
    tmp_path: Path,
):
    token = "awei-private-test-token"
    upstream = Settings(
        provider_mode="mock",
        require_access_token=True,
        allow_direct_synthesis=False,
        access_token_hashes=(
            AccessTokenHash(
                subject="tester",
                sha256=hashlib.sha256(token.encode()).hexdigest(),
            ),
        ),
        quota_database_path=str(tmp_path / "quota.sqlite3"),
    )
    app = create_app(
        WebSettings(allowed_web_origins=(WEB_ORIGIN,)),
        upstream,
    )

    missing = await request(
        app,
        "GET",
        "/v1/access",
        headers={"Origin": WEB_ORIGIN},
    )
    accepted = await request(
        app,
        "GET",
        "/v1/access",
        headers={
            "Origin": WEB_ORIGIN,
            "Authorization": f"Bearer {token}",
        },
    )

    assert missing.status_code == 401
    assert missing.headers["access-control-allow-origin"] == WEB_ORIGIN
    assert accepted.status_code == 200
    assert accepted.json()["subject"] == "tester"


async def test_direct_synthesis_endpoint_is_not_exposed():
    response = await request(
        mock_app(),
        "POST",
        "/v1/synthesize",
        headers={"Origin": WEB_ORIGIN},
        json=REQUEST,
    )

    assert response.status_code == 404
