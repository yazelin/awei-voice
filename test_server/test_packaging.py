from pathlib import Path


PINNED_UPSTREAM_SHA = "df4c211e3e69215c9766b2304d8443e1cb8efa57"


def test_upstream_git_dependency_uses_full_commit_sha():
    pyproject = (
        Path(__file__).parents[1] / "server" / "pyproject.toml"
    ).read_text(encoding="utf-8")

    assert (
        "git+https://github.com/yazelin/taigi-news-reader.git@"
        f"{PINNED_UPSTREAM_SHA}#subdirectory=backend"
    ) in pyproject
    assert "taigi-news-reader.git@main" not in pyproject


def test_container_user_matches_the_shared_model_cache_owner():
    dockerfile = (
        Path(__file__).parents[1] / "server" / "Dockerfile"
    ).read_text(encoding="utf-8")

    assert "ARG AWEI_UID=999" in dockerfile
    assert "ARG AWEI_GID=999" in dockerfile
    assert 'useradd --system --uid "$AWEI_UID"' in dockerfile
    assert "USER awei" in dockerfile
