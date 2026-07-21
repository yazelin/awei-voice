from pathlib import Path


ROOT = Path(__file__).parents[1]
DEPLOY = ROOT / "deploy" / "production"


def test_production_compose_is_private_bounded_and_uses_separate_quota():
    compose = (DEPLOY / "compose.yaml").read_text(encoding="utf-8")

    assert "ports:" not in compose
    assert "env_file:" not in compose
    assert "TAIGI_OPENAI_API_KEY:" in compose
    assert "TAIGI_OPENAI_BASE_URL:" in compose
    assert "TAIGI_OPENAI_MODEL:" in compose
    assert 'AWEI_ALLOWED_WEB_ORIGINS: "https://yazelin.github.io"' in compose
    assert 'AWEI_REQUIRE_WEB_ORIGIN: "true"' in compose
    assert 'TAIGI_REQUIRE_ACCESS_TOKEN: "false"' in compose
    assert 'TAIGI_ENFORCE_OPEN_ACCESS_QUOTA: "true"' in compose
    assert 'TAIGI_MANDARIN_TTS_PROVIDER: "edge"' in compose
    assert 'TAIGI_EDGE_TTS_VOICE: "zh-TW-HsiaoChenNeural"' in compose
    assert "TAIGI_QUOTA_DATABASE_PATH: /var/lib/awei/quota.sqlite3" in compose
    assert 'TAIGI_DAILY_SUBJECT_JOB_LIMIT: "120"' in compose
    assert 'TAIGI_DAILY_GLOBAL_JOB_LIMIT: "120"' in compose
    assert "taigi-news-reader-lan_model-cache" in compose
    assert "- quota-data:/var/lib/awei" in compose
    assert "- model-cache:/var/cache/awei" in compose
    assert "awei-voice-backend" in compose
    assert "mem_limit: 2g" in compose
    assert 'cpus: "4.0"' in compose
    assert "read_only: true" in compose


def test_nginx_uses_exact_pages_origin_and_only_new_base_path():
    http = (
        DEPLOY / "nginx" / "01-awei-voice-http.conf.example"
    ).read_text(encoding="utf-8")
    locations = (
        DEPLOY / "nginx" / "awei-voice-locations.inc"
    ).read_text(encoding="utf-8")

    assert '"https://yazelin.github.io" 1;' in http
    assert "\nmap_hash_bucket_size " not in http
    assert "default 0;" in http
    assert "$binary_remote_addr" in http
    assert "server awei-voice-backend:8765 resolve;" in http
    assert "auth_request /_awei-web-origin-gate;" in locations
    assert "location = /awei-voice/v1/synthesis-jobs" in locations
    assert "location ^~ /awei-voice/v1/synthesis-jobs/" in locations
    assert "proxy_buffering off;" in locations
    assert "location = /awei-voice/v1/synthesize" in locations
    fallback = locations[locations.index("location = /awei-voice/v1/synthesize"):]
    assert fallback.count("server_tokens off;") == 4
    assert fallback.count("access_log off;") == 4
    assert "location = /taigi-tts" not in locations
    assert "location ^~ /taigi-tts" not in locations
    assert "proxy_pass http://taigi" not in locations
