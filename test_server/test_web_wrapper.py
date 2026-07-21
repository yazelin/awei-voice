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


def mock_app(
    tmp_path: Path,
    *,
    localhost: bool = True,
    require_origin: bool = False,
):
    return create_app(
        WebSettings(
            allowed_web_origins=(WEB_ORIGIN,),
            allow_localhost_origins=localhost,
            require_web_origin=require_origin,
        ),
        Settings(
            provider_mode="mock",
            quota_database_path=str(tmp_path / "quota.sqlite3"),
        ),
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


async def test_health_is_mock_and_does_not_load_a_model(tmp_path):
    app = mock_app(tmp_path)
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
    body = response.json()
    assert body["status"] == "ok"
    assert body["mode"] == "mock"
    assert body["translator"] == "mock:taigi-translator"
    assert body["synthesizer"] == "mock:wav-synthesizer"
    assert body["mandarin_synthesizer"] == (
        "mock:online-mandarin-backup"
    )
    assert body["source_languages"] == ["zh-TW", "nan-Latn-TW"]
    assert body["target_languages"] == ["nan-TW", "zh-TW"]
    assert body["capabilities"][-1] == {
        "source_language": "zh-TW",
        "target_language": "zh-TW",
        "mode": "online-mandarin-backup",
        "provider": "direct:zh-TW+mock:online-mandarin-backup",
        "network_required": True,
        "unofficial": True,
        "sla_guaranteed": False,
    }
    assert old_extension_origin.status_code == 403
    assert "access-control-allow-origin" not in old_extension_origin.headers


async def test_production_origin_mode_rejects_missing_origin_only_on_v1(
    tmp_path,
):
    app = mock_app(tmp_path, localhost=False, require_origin=True)

    health = await request(app, "GET", "/health")
    missing = await request(app, "GET", "/v1/access")
    allowed = await request(
        app,
        "GET",
        "/v1/access",
        headers={"Origin": WEB_ORIGIN},
    )

    assert health.status_code == 200
    assert missing.status_code == 403
    assert missing.json() == {"detail": "request web origin is required"}
    assert missing.headers["cache-control"] == "no-store"
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == WEB_ORIGIN


async def test_configured_web_origin_can_use_async_jobs_without_extension_id(
    tmp_path,
):
    app = mock_app(tmp_path)
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


async def test_legacy_extension_environment_is_ignored(monkeypatch, tmp_path):
    monkeypatch.setenv("TAIGI_PROVIDER_MODE", "mock")
    monkeypatch.setenv("TAIGI_EXTENSION_IDS", "not-an-extension-id")
    monkeypatch.setenv("TAIGI_REQUIRE_ALLOWED_ORIGIN", "true")
    monkeypatch.setenv(
        "TAIGI_QUOTA_DATABASE_PATH",
        str(tmp_path / "quota.sqlite3"),
    )

    app = create_app(WebSettings(allowed_web_origins=(WEB_ORIGIN,)))
    response = await request(
        app,
        "GET",
        "/health",
        headers={"Origin": WEB_ORIGIN},
    )

    assert response.status_code == 200
    assert response.json()["mode"] == "mock"


async def test_async_job_poll_and_terminal_result_contract_is_preserved(
    tmp_path,
):
    app = mock_app(tmp_path)
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
    assert body["result"]["spoken_text"] == body["result"]["taigi_text"]
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


@pytest.mark.parametrize(
    ("source_language", "target_language", "text", "provider", "has_taigi"),
    [
        (
            "nan-Latn-TW",
            "nan-TW",
            "Kin-á-ji̍t thiⁿ-khì chin hó。",
            "direct:nan-Latn-TW+mock:wav-synthesizer",
            True,
        ),
        (
            "zh-TW",
            "zh-TW",
            "今天天氣真好。",
            "direct:zh-TW+mock:online-mandarin-backup",
            False,
        ),
    ],
)
async def test_web_async_jobs_preserve_input_and_target_mode(
    tmp_path,
    source_language,
    target_language,
    text,
    provider,
    has_taigi,
):
    app = mock_app(tmp_path)
    headers = {"Origin": WEB_ORIGIN}
    created = await request(
        app,
        "POST",
        "/v1/synthesis-jobs",
        headers=headers,
        json={
            "text": text,
            "source_language": source_language,
            "target_language": target_language,
            "rate": 1.0,
        },
    )

    terminal = None
    for _ in range(20):
        response = await request(
            app,
            "GET",
            f"/v1/synthesis-jobs/{created.json()['job_id']}",
            headers=headers,
        )
        if response.json()["status"] != "pending":
            terminal = response.json()
            break
        await asyncio.sleep(0)

    assert terminal is not None
    result = terminal["result"]
    expected_spoken_text = (
        "kin-á-ji̍t thinn-khì chin hó"
        if source_language == "nan-Latn-TW"
        else text
    )
    assert result["spoken_text"] == expected_spoken_text
    assert result["provider"] == provider
    assert bool(result["taigi_text"]) is has_taigi


async def test_formal_pages_origin_is_allowed_exactly(tmp_path):
    formal_origin = "https://yazelin.github.io"
    upstream = Settings(
        provider_mode="mock",
        quota_database_path=str(tmp_path / "formal-origin-quota.sqlite3"),
    )
    app = create_app(
        WebSettings(
            allowed_web_origins=(formal_origin,),
            allow_localhost_origins=False,
            require_web_origin=True,
        ),
        upstream,
    )

    allowed = await request(
        app,
        "GET",
        "/v1/access",
        headers={"Origin": formal_origin},
    )
    lookalike = await request(
        app,
        "GET",
        "/v1/access",
        headers={"Origin": f"{formal_origin}.evil.example"},
    )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == formal_origin
    assert lookalike.status_code == 403
    assert "access-control-allow-origin" not in lookalike.headers


async def test_web_wrapper_enforces_durable_open_access_quota(tmp_path):
    upstream = Settings(
        provider_mode="mock",
        quota_database_path=str(tmp_path / "open-quota.sqlite3"),
        daily_subject_job_limit=1,
        daily_subject_character_limit=100,
        daily_global_job_limit=1,
        daily_global_character_limit=100,
    )
    app = create_app(
        WebSettings(allowed_web_origins=(WEB_ORIGIN,)),
        upstream,
    )
    headers = {"Origin": WEB_ORIGIN}

    access = await request(app, "GET", "/v1/access", headers=headers)
    first = await request(
        app,
        "POST",
        "/v1/synthesis-jobs",
        headers=headers,
        json=REQUEST,
    )
    second = await request(
        app,
        "POST",
        "/v1/synthesis-jobs",
        headers=headers,
        json=REQUEST,
    )

    assert access.status_code == 200
    assert access.json()["authentication_required"] is False
    assert access.json()["subject"] == "local-open-access"
    assert first.status_code == 202
    assert second.status_code == 429
    assert second.headers["x-ratelimit-scope"] in {
        "subject_jobs",
        "global_jobs",
    }


async def test_localhost_origin_is_allowed_but_unlisted_remote_origin_is_rejected(
    tmp_path,
):
    app = mock_app(tmp_path)
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


async def test_direct_synthesis_endpoint_is_not_exposed(tmp_path):
    response = await request(
        mock_app(tmp_path),
        "POST",
        "/v1/synthesize",
        headers={"Origin": WEB_ORIGIN},
        json=REQUEST,
    )

    assert response.status_code == 404
