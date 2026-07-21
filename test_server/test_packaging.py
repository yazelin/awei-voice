from pathlib import Path


PINNED_UPSTREAM_SHA = "967d7370fb5f3b22cc4492c5ee5753fba3ae2904"


def test_upstream_git_dependency_uses_full_commit_sha():
    pyproject = (
        Path(__file__).parents[1] / "server" / "pyproject.toml"
    ).read_text(encoding="utf-8")

    assert (
        "git+https://github.com/yazelin/taigi-news-reader.git@"
        f"{PINNED_UPSTREAM_SHA}#subdirectory=backend"
    ) in pyproject
    assert "taigi-news-reader.git@main" not in pyproject

