"""CONTRACT-V6-DOWNLOAD: /api/downloads, /indir/dosya/<platform>, /indir."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from trio_server import Settings, create_app
from trio_server.config import ConfigError
from trio_server.downloads import DownloadConfig, parse_signing, parse_sums

from .conftest import INVITE, Clock

API = "https://gh.test"
DL = "https://dl.test"
REPO = "friends/Trio"
TOKEN = "ghp_SECRET-TOKEN-never-shown"
SHA_WIN = "a" * 64
SHA_ARM = "b" * 64
SHA_LIN = "c" * 64


def asset(asset_id: int, name: str, size: int = 1000, digest: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "id": asset_id,
        "name": name,
        "size": size,
        "state": "uploaded",
        "url": f"{API}/repos/{REPO}/releases/assets/{asset_id}",
        "browser_download_url": f"{DL}/{REPO}/releases/download/v0.5.0/{name}",
    }
    if digest is not None:
        body["digest"] = digest
    return body


def release(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "tag_name": "v0.5.0",
        "name": "Trio v0.5.0",
        "draft": False,
        "prerelease": False,
        "published_at": "2026-11-18T09:30:00Z",
        "assets": [
            asset(1, "Trio-0.5.0-win-x64.exe", 90_000_000, f"sha256:{SHA_WIN}"),
            asset(2, "Trio-0.5.0-mac-arm64.dmg", 110_000_000),
            asset(3, "Trio-0.5.0-mac-x64.dmg", 115_000_000),
            asset(4, "Trio-0.5.0-linux-x86_64.AppImage", 120_000_000),
            asset(5, "Trio-0.5.0-win-x64.exe.blockmap", 100),
            asset(6, "evil.exe", 1),
            asset(7, "SHA256SUMS.txt", 300),
            asset(8, "signing.json", 40),
        ],
    }
    body.update(overrides)
    return body


class FakeGitHub:
    def __init__(self) -> None:
        self.release: dict[str, Any] | None = release()
        self.status = 200
        self.sums = f"{SHA_WIN}  Trio-0.5.0-win-x64.exe\n{SHA_ARM} *Trio-0.5.0-mac-arm64.dmg\n"
        self.sums += f"{SHA_LIN}  Trio-0.5.0-linux-x86_64.AppImage\n"
        self.signing: str | None = None
        self.requests: list[httpx.Request] = []
        self.asset_mode = "redirect"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url == f"{API}/repos/{REPO}/releases/latest":
            if self.status != 200 or self.release is None:
                return httpx.Response(self.status if self.status != 200 else 404, json={})
            return httpx.Response(200, json=self.release)
        if url.startswith(f"{API}/repos/{REPO}/releases/assets/"):
            asset_id = int(url.rsplit("/", 1)[1])
            assert request.headers["accept"] == "application/octet-stream"
            if self.asset_mode == "stream":
                return httpx.Response(200, content=b"MZ-installer-bytes")
            if self.asset_mode == "fail":
                return httpx.Response(500)
            return httpx.Response(
                302, headers={"Location": f"https://storage.test/{asset_id}?sig=abc"}
            )
        if url.startswith("https://storage.test/"):
            assert "authorization" not in request.headers
            asset_id = int(request.url.path.strip("/"))
            return self._small(asset_id)
        if url.startswith(f"{DL}/{REPO}/releases/download/"):
            assert "authorization" not in request.headers
            name = url.rsplit("/", 1)[1]
            return self._small({"SHA256SUMS.txt": 7, "signing.json": 8}.get(name, 0))
        return httpx.Response(404)

    def _small(self, asset_id: int) -> httpx.Response:
        if asset_id == 7:
            return httpx.Response(200, text=self.sums)
        if asset_id == 8 and self.signing is not None:
            return httpx.Response(200, text=self.signing)
        return httpx.Response(404)


@pytest.fixture
def github() -> FakeGitHub:
    return FakeGitHub()


@pytest.fixture
def make_app(tmp_path, github) -> Iterator[Callable[..., tuple[TestClient, Clock]]]:
    opened: list[TestClient] = []

    def factory(token: str | None = None, static: bool = False) -> tuple[TestClient, Clock]:
        clock = Clock()
        static_dir = None
        if static:
            static_dir = tmp_path / "dist"
            static_dir.mkdir(exist_ok=True)
            (static_dir / "index.html").write_text("<html>app</html>")
            (static_dir / "indir.html").write_text("<html>indir</html>")
        app = create_app(
            Settings(
                invite_code=INVITE,
                db_path=str(tmp_path / f"t{len(opened)}.db"),
                upload_dir=str(tmp_path / f"u{len(opened)}"),
                static_dir=str(static_dir) if static_dir else None,
            ),
            now=clock,
            http_transport=httpx.MockTransport(github),
            downloads=DownloadConfig(repo=REPO, token=token, api_url=API, download_url=DL),
        )
        client = TestClient(app)
        client.__enter__()
        opened.append(client)
        return client, clock

    yield factory
    for client in opened:
        client.__exit__(None, None, None)


def test_lists_the_latest_release(make_app, github) -> None:
    client, _ = make_app()
    response = client.get("/api/downloads")
    assert response.status_code == 200
    body = response.json()
    assert body["version"] == "0.5.0"
    assert body["published_at"] == "2026-11-18T09:30:00Z"
    assert body["signed"] == {"windows": False, "mac": False}
    files = {f["platform"]: f for f in body["files"]}
    assert list(files) == ["windows", "mac-arm64", "mac-x64", "linux"]
    assert files["windows"] == {
        "platform": "windows",
        "name": "Trio-0.5.0-win-x64.exe",
        "size": 90_000_000,
        "sha256": SHA_WIN,
        "url": "/indir/dosya/windows",
    }
    # From SHA256SUMS.txt (no GitHub digest), from the digest, and from neither.
    assert files["mac-arm64"]["sha256"] == SHA_ARM
    assert files["mac-x64"]["sha256"] is None
    assert files["linux"]["sha256"] == SHA_LIN
    # Public: no token needed, none sent upstream without one.
    assert all("authorization" not in r.headers for r in github.requests)


def test_cached_for_ten_minutes(make_app, github) -> None:
    client, clock = make_app()
    client.get("/api/downloads")
    first = len(github.requests)
    client.get("/api/downloads")
    clock.value += 599
    client.get("/api/downloads")
    assert len(github.requests) == first
    clock.value += 2
    github.release = release(tag_name="v0.5.1", assets=[])
    assert client.get("/api/downloads").json()["version"] == "0.5.1"


def test_stale_while_error(make_app, github) -> None:
    client, clock = make_app()
    assert client.get("/api/downloads").json()["version"] == "0.5.0"
    github.status = 503
    clock.value += 601
    body = client.get("/api/downloads").json()
    assert body["version"] == "0.5.0" and len(body["files"]) == 4


def test_unavailable_without_cache(make_app, github) -> None:
    github.status = 500
    client, clock = make_app()
    assert client.get("/api/downloads").json() == {
        "version": None,
        "published_at": None,
        "signed": {"windows": False, "mac": False},
        "files": [],
    }
    asked = len(github.requests)
    client.get("/api/downloads")
    assert len(github.requests) == asked  # not hammered
    github.status = 200
    clock.value += 61
    assert client.get("/api/downloads").json()["version"] == "0.5.0"


def test_names_of_another_version_and_odd_assets_are_ignored(make_app, github) -> None:
    github.release = release(
        assets=[
            asset(1, "Trio-0.4.9-win-x64.exe"),
            asset(2, "Trio-0.5.0-win-x64.exe.exe"),
            asset(3, "../Trio-0.5.0-mac-x64.dmg"),
            {
                **asset(4, "Trio-0.5.0-linux-x86_64.AppImage"),
                "browser_download_url": "https://evil.test/x",
            },
            {**asset(5, "Trio-0.5.0-mac-arm64.dmg"), "state": "new"},
        ]
    )
    client, _ = make_app()
    assert client.get("/api/downloads").json()["files"] == []


def test_a_prerelease_answer_is_refused(make_app, github) -> None:
    github.release = release(prerelease=True)
    client, _ = make_app()
    assert client.get("/api/downloads").json()["version"] is None


def test_digest_and_sums_disagree_shows_no_hash(make_app, github) -> None:
    github.sums = f"{'f' * 64}  Trio-0.5.0-win-x64.exe\n"
    client, _ = make_app()
    files = {f["platform"]: f for f in client.get("/api/downloads").json()["files"]}
    assert files["windows"]["sha256"] is None


def test_signing_json(make_app, github) -> None:
    github.signing = json.dumps({"windows": True, "mac": "yes"})
    client, _ = make_app()
    assert client.get("/api/downloads").json()["signed"] == {"windows": True, "mac": False}


def test_parsers() -> None:
    assert parse_sums(f"{'A' * 64}  x.exe\nnonsense\n") == {"x.exe": "a" * 64}
    assert parse_signing("[]") == {"windows": False, "mac": False}
    assert parse_signing("{") == {"windows": False, "mac": False}


def test_redirect_without_token(make_app) -> None:
    client, _ = make_app()
    response = client.get("/indir/dosya/linux", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == (
        f"{DL}/{REPO}/releases/download/v0.5.0/Trio-0.5.0-linux-x86_64.AppImage"
    )
    assert response.headers["cache-control"] == "no-store"


def test_unknown_platform_is_404(make_app, github) -> None:
    client, _ = make_app()
    for platform in ("android", "..", "windows.exe", "WINDOWS"):
        response = client.get(f"/indir/dosya/{platform}", follow_redirects=False)
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "NOT_FOUND"
    assert github.requests == []


def test_known_platform_missing_from_release_is_404(make_app, github) -> None:
    github.release = release(assets=[asset(1, "Trio-0.5.0-win-x64.exe")])
    client, _ = make_app()
    assert client.get("/indir/dosya/mac-x64", follow_redirects=False).status_code == 404


def test_private_repo_redirects_to_signed_location(make_app, github, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    client, _ = make_app(token=TOKEN)
    body = client.get("/api/downloads")
    assert TOKEN not in body.text
    assert body.json()["files"][1]["sha256"] == SHA_ARM  # SHA256SUMS read via the asset API
    response = client.get("/indir/dosya/windows", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == "https://storage.test/1?sig=abc"
    assert TOKEN not in str(response.headers) and TOKEN not in response.text
    api_calls = [r for r in github.requests if str(r.url).startswith(API)]
    assert api_calls and all(r.headers["authorization"] == f"Bearer {TOKEN}" for r in api_calls)
    assert TOKEN not in caplog.text


def test_private_repo_streamed_asset_is_relayed(make_app, github) -> None:
    client, _ = make_app(token=TOKEN)
    client.get("/api/downloads")
    github.asset_mode = "stream"
    response = client.get("/indir/dosya/windows", follow_redirects=False)
    assert response.status_code == 200
    assert response.content == b"MZ-installer-bytes"
    assert "Trio-0.5.0-win-x64.exe" in response.headers["content-disposition"]


def test_private_repo_asset_failure_is_502(make_app, github) -> None:
    client, _ = make_app(token=TOKEN)
    client.get("/api/downloads")
    github.asset_mode = "fail"
    response = client.get("/indir/dosya/windows", follow_redirects=False)
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "DOWNLOAD_UNAVAILABLE"


def test_downloads_are_rate_limited_per_address(make_app) -> None:
    client, clock = make_app()
    one = {"X-Forwarded-For": "203.0.113.9"}
    for _ in range(20):
        assert (
            client.get("/indir/dosya/linux", headers=one, follow_redirects=False).status_code == 302
        )
    refused = client.get("/indir/dosya/linux", headers=one, follow_redirects=False)
    assert refused.status_code == 429 and int(refused.headers["retry-after"]) > 0
    other = {"X-Forwarded-For": "203.0.113.10"}
    assert (
        client.get("/indir/dosya/linux", headers=other, follow_redirects=False).status_code == 302
    )
    clock.value += 601
    assert client.get("/indir/dosya/linux", headers=one, follow_redirects=False).status_code == 302


def test_page_and_redirects(make_app) -> None:
    client, _ = make_app(static=True)
    page = client.get("/indir")
    assert page.status_code == 200 and "indir" in page.text
    assert "script-src 'self'" in page.headers["content-security-policy"]
    assert page.headers["x-frame-options"] == "DENY"
    for path in ("/download", "/indir/", "/indir.html"):
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 302 and response.headers["location"] == "/indir"
    # The SPA fallback is untouched.
    assert client.get("/kanal/3").text == "<html>app</html>"


def test_page_link_preview_urls_become_absolute(make_app, tmp_path) -> None:
    client, _ = make_app(static=True)
    (tmp_path / "dist" / "indir.html").write_text(
        '<head><meta property="og:image" content="/og/trio-og.png" />'
        '<meta property="og:url" content="/indir" />'
        '<meta name="theme-color" content="#111318" />'
        '<meta name="x" content="//evil.example/a" />'
        '<link rel="icon" href="/favicon.svg" /></head>'
    )
    forwarded = {"host": "trio.example:8443", "x-forwarded-proto": "https, http"}
    page = client.get("/indir", headers=forwarded)
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    assert 'content="https://trio.example:8443/og/trio-og.png"' in page.text
    assert 'content="https://trio.example:8443/indir"' in page.text
    # Only root-relative meta content changes: colours, protocol-relative values and links stay.
    assert 'content="#111318"' in page.text
    assert 'content="//evil.example/a"' in page.text
    assert 'href="/favicon.svg"' in page.text
    # Without a forwarded scheme, the request's own; an odd Host changes nothing.
    plain = {"host": "trio.example"}
    assert 'content="http://trio.example/indir"' in client.get("/indir", headers=plain).text
    odd = client.get("/indir", headers={"host": 'x" onload="y', "x-forwarded-proto": "https"})
    assert 'content="/og/trio-og.png"' in odd.text and "onload" not in odd.text
    head = client.head("/indir", headers=plain)
    assert head.status_code == 200 and head.text == ""
    assert int(head.headers["content-length"]) == len(client.get("/indir", headers=plain).content)


def test_page_canonical_and_structured_data_become_absolute(make_app, tmp_path) -> None:
    client, _ = make_app(static=True)
    (tmp_path / "dist" / "indir.html").write_text(
        '<head><link rel="canonical" href="/indir" />'
        '<link rel="icon" href="/favicon.svg" />'
        '<script type="application/ld+json">{"url": "/indir", "image": "/og/trio-og.png",'
        ' "sameAs": "https://github.com/x/y", "name": "/not-a-url-key"}</script>'
        '<script>{"url": "/outside"}</script></head>'
    )
    page = client.get("/indir", headers={"host": "trio.example", "x-forwarded-proto": "https"})
    assert '<link rel="canonical" href="https://trio.example/indir" />' in page.text
    assert '"url": "https://trio.example/indir"' in page.text
    assert '"image": "https://trio.example/og/trio-og.png"' in page.text
    # Only url/image inside the JSON-LD block; other keys, other scripts and links stay.
    assert '"name": "/not-a-url-key"' in page.text
    assert '{"url": "/outside"}' in page.text
    assert 'href="/favicon.svg"' in page.text
    odd = client.get("/indir", headers={"host": "x/y", "x-forwarded-proto": "https"})
    assert '<link rel="canonical" href="/indir" />' in odd.text


def test_robots_and_sitemap(make_app) -> None:
    client, _ = make_app(static=True)
    host = {"host": "trio.example:8443", "x-forwarded-proto": "https"}
    robots = client.get("/robots.txt", headers=host)
    assert robots.status_code == 200
    assert robots.headers["content-type"].startswith("text/plain")
    lines = robots.text.splitlines()
    assert lines[0] == "User-agent: *"
    for rule in ("Allow: /indir", "Disallow: /api/", "Disallow: /ws", "Disallow: /indir/dosya/"):
        assert rule in lines
    # The app shell is not disallowed: it says noindex itself, and a crawler must read that.
    assert "Disallow: /" not in lines
    assert "Sitemap: https://trio.example:8443/sitemap.xml" in lines
    sitemap = client.get("/sitemap.xml", headers=host)
    assert sitemap.status_code == 200
    assert sitemap.headers["content-type"].startswith("application/xml")
    assert "<loc>https://trio.example:8443/indir</loc>" in sitemap.text
    assert sitemap.text.count("<loc>") == 1
    # Without a trustworthy host: no Sitemap line, and no sitemap.
    odd = {"host": 'x" y'}
    assert "Sitemap" not in client.get("/robots.txt", headers=odd).text
    assert client.get("/sitemap.xml", headers=odd).status_code == 404
    assert client.head("/robots.txt", headers=host).status_code == 200


def test_app_shell_is_noindex_and_the_site_is_not(make_app) -> None:
    client, _ = make_app(static=True)
    assert client.get("/").headers["x-robots-tag"] == "noindex"
    assert client.get("/index.html").headers["x-robots-tag"] == "noindex"
    assert client.get("/kanal/3").headers["x-robots-tag"] == "noindex"
    assert "x-robots-tag" not in client.get("/indir").headers


def test_page_without_static_dir_is_404(make_app) -> None:
    client, _ = make_app()
    assert client.get("/indir").status_code == 404


def test_config() -> None:
    config = DownloadConfig.from_env(
        {
            "TRIO_GITHUB_TOKEN": " t0k ",
            "TRIO_RELEASES_REPO": "a/b",
            "TRIO_GITHUB_API_URL": "http://x/",
        }
    )
    assert config.token == "t0k" and config.repo == "a/b" and config.api_url == "http://x"
    assert "t0k" not in repr(config)
    assert DownloadConfig.from_env({}).repo == "borankaraduman-star/Trio"
    with pytest.raises(ConfigError):
        DownloadConfig(repo="https://github.com/a/b")
    with pytest.raises(ConfigError):
        DownloadConfig(api_url="ftp://x")
