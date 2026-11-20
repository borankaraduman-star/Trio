"""The public download page's data and file links (CONTRACT-V6-DOWNLOAD.md).

    GET /api/downloads           the latest release's installers (no token needed)
    GET /indir/dosya/<platform>  302 to that installer
    GET /indir                   the page itself (web/indir.html, built by Vite)
    GET /download, /indir/       302 to /indir

The installers live on GitHub, as assets of the newest non-prerelease release
of ``TRIO_RELEASES_REPO``; ``releases/latest`` is exactly that (GitHub never
answers a draft or a prerelease there). What the server learns is kept in
memory for ten minutes and served stale when GitHub fails; with nothing
learnt yet the answer is an empty list, and the page says so.

The repository may be private. Then ``TRIO_GITHUB_TOKEN`` (read-only
contents) is sent to the API, and a visitor's download asks the asset API
for the file with ``Accept: application/octet-stream`` WITHOUT following its
redirect: the Location it answers is a short-lived signed address on GitHub's
storage, and the visitor is sent there. The token itself never leaves the
server: it is in no response, no redirect and no log line.

What a visitor can choose is only the platform word. The file it leads to is
an asset of the cached latest release whose name matches the strict pattern of
electron-builder's own artifact names (desktop/package.json, ``artifactName``
``Trio-${version}-${os}-${arch}.${ext}``) for that version; nothing in the
request becomes part of a URL.

SHA-256 per file: GitHub's own ``digest`` on the asset ("sha256:<hex>", set
on uploads since June 2025) and the ``SHA256SUMS.txt`` the release workflow
attaches. Either one is enough; when both are present and disagree, neither
is shown, because a hash the page cannot stand behind is worse than none.

Signing: the workflow attaches ``signing.json`` (``{"windows": bool, "mac":
bool}``, true only when that build was really signed, and for macOS also
notarized). Absent or unreadable means unsigned, which is what every release
so far is.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
    StreamingResponse,
)

from trio_server.config import ConfigError
from trio_server.errors import error_response
from trio_server.ratelimit import SlidingWindow, client_address

logger = logging.getLogger("trio.downloads")

DEFAULT_REPO = "borankaraduman-star/Trio"
DEFAULT_API_URL = "https://api.github.com"
DEFAULT_DOWNLOAD_URL = "https://github.com"

CACHE_SECONDS = 600
# After a failure with nothing cached, GitHub is asked again at most this often.
RETRY_SECONDS = 60
TIMEOUT_SECONDS = 10.0
# SHA256SUMS.txt and signing.json are a few hundred bytes; anything bigger is not ours.
SMALL_ASSET_MAX_BYTES = 64 * 1024
# Downloads per client address: plenty for three friends and a few retries.
DOWNLOAD_ATTEMPTS = 20
DOWNLOAD_WINDOW_SECONDS = 600

PLATFORMS = ("windows", "mac-arm64", "mac-x64", "linux")
_VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?"
_SEMVER = re.compile(rf"^{_VERSION}$")
# electron-builder's names: ${os} is win|mac|linux, ${arch} x64|arm64, and an
# AppImage spells x64 as x86_64 (getArtifactArchName).
ASSET_PATTERNS = {
    "windows": re.compile(rf"^Trio-(?P<version>{_VERSION})-win-x64\.exe$"),
    "mac-arm64": re.compile(rf"^Trio-(?P<version>{_VERSION})-mac-arm64\.dmg$"),
    "mac-x64": re.compile(rf"^Trio-(?P<version>{_VERSION})-mac-x64\.dmg$"),
    "linux": re.compile(rf"^Trio-(?P<version>{_VERSION})-linux-(?:x86_64|x64)\.AppImage$"),
}
SUMS_NAME = "SHA256SUMS.txt"
SIGNING_NAME = "signing.json"
_REPO = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_SUMS_LINE = re.compile(r"^([0-9a-fA-F]{64}) [ *](.+)$")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


@dataclass(frozen=True)
class DownloadConfig:
    repo: str = DEFAULT_REPO
    token: str | None = None
    api_url: str = DEFAULT_API_URL
    # Where an asset's browser_download_url must point (the fake GitHub in tests).
    download_url: str = DEFAULT_DOWNLOAD_URL

    def __post_init__(self) -> None:
        if not _REPO.match(self.repo):
            raise ConfigError("TRIO_RELEASES_REPO must look like owner/name")
        for name, url in (
            ("TRIO_GITHUB_API_URL", self.api_url),
            ("TRIO_GITHUB_DOWNLOAD_URL", self.download_url),
        ):
            parts = urlsplit(url)
            if parts.scheme not in ("http", "https") or not parts.netloc or url.endswith("/"):
                raise ConfigError(f"{name} must be an http(s) URL without a trailing slash")

    # Never print the token.
    def __repr__(self) -> str:
        return (
            f"DownloadConfig(repo={self.repo!r}, token={'set' if self.token else 'unset'}, "
            f"api_url={self.api_url!r}, download_url={self.download_url!r})"
        )

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> DownloadConfig:
        env = os.environ if env is None else env

        def value(name: str, default: str) -> str:
            return env.get(name, "").strip().rstrip("/") or default

        return cls(
            repo=value("TRIO_RELEASES_REPO", DEFAULT_REPO),
            token=env.get("TRIO_GITHUB_TOKEN", "").strip() or None,
            api_url=value("TRIO_GITHUB_API_URL", DEFAULT_API_URL),
            download_url=value("TRIO_GITHUB_DOWNLOAD_URL", DEFAULT_DOWNLOAD_URL),
        )


@dataclass(frozen=True)
class FileEntry:
    platform: str
    name: str
    size: int
    sha256: str | None
    asset_id: int
    browser_url: str


@dataclass(frozen=True)
class Catalog:
    version: str | None = None
    published_at: str | None = None
    files: tuple[FileEntry, ...] = ()
    signed: Mapping[str, bool] = field(default_factory=lambda: {"windows": False, "mac": False})

    def public(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "published_at": self.published_at,
            "signed": dict(self.signed),
            "files": [
                {
                    "platform": f.platform,
                    "name": f.name,
                    "size": f.size,
                    "sha256": f.sha256,
                    "url": f"/indir/dosya/{f.platform}",
                }
                for f in self.files
            ],
        }

    def file(self, platform: str) -> FileEntry | None:
        return next((f for f in self.files if f.platform == platform), None)


EMPTY = Catalog()


def parse_sums(text: str) -> dict[str, str]:
    """``sha256sum`` output: "<hex>  <name>" (or "<hex> *<name>") per line."""
    sums: dict[str, str] = {}
    for line in text.splitlines():
        match = _SUMS_LINE.match(line.strip())
        if match:
            sums[match.group(2).strip()] = match.group(1).lower()
    return sums


def parse_signing(text: str) -> dict[str, bool]:
    try:
        data = json.loads(text)
    except ValueError:
        return {"windows": False, "mac": False}
    if not isinstance(data, dict):
        return {"windows": False, "mac": False}
    return {key: data.get(key) is True for key in ("windows", "mac")}


def _digest(asset: Mapping[str, Any]) -> str | None:
    raw = asset.get("digest")
    if isinstance(raw, str) and raw.startswith("sha256:"):
        hexed = raw[len("sha256:") :].lower()
        if _HEX64.match(hexed):
            return hexed
    return None


class DownloadCatalog:
    """The latest release, as far as the page needs it, cached in memory."""

    def __init__(
        self,
        config: DownloadConfig,
        now: Callable[[], float],
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.config = config
        self._now = now
        self._transport = transport
        self._cached: Catalog | None = None
        self._fresh_until = 0.0
        self._retry_at = 0.0
        self._lock = asyncio.Lock()

    def client(self, timeout: httpx.Timeout | float = TIMEOUT_SECONDS) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self._transport, timeout=timeout)

    def api_headers(self, accept: str = "application/vnd.github+json") -> dict[str, str]:
        headers = {
            "Accept": accept,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "trio-server",
        }
        if self.config.token:
            headers["Authorization"] = f"Bearer {self.config.token}"
        return headers

    def asset_api_url(self, asset_id: int) -> str:
        return f"{self.config.api_url}/repos/{self.config.repo}/releases/assets/{asset_id}"

    def browser_url_ok(self, url: str, name: str) -> bool:
        prefix = f"{self.config.download_url}/{self.config.repo}/releases/download/".lower()
        return url.lower().startswith(prefix) and url.endswith(f"/{name}") and "?" not in url

    async def get(self) -> Catalog:
        now = self._now()
        if self._cached is not None and now < self._fresh_until:
            return self._cached
        if self._cached is None and now < self._retry_at:
            return EMPTY
        async with self._lock:
            now = self._now()
            if self._cached is not None and now < self._fresh_until:
                return self._cached
            if self._cached is None and now < self._retry_at:
                return EMPTY
            try:
                catalog = await self._fetch()
            except Exception as exc:  # noqa: BLE001 - the page never fails because GitHub did
                detail = type(exc).__name__
                if isinstance(exc, httpx.HTTPStatusError):
                    detail += f" status={exc.response.status_code}"
                logger.warning("downloads.release.failed %s", detail)
                if self._cached is not None:
                    # Stale while error: keep answering, ask again in a minute.
                    self._fresh_until = self._now() + RETRY_SECONDS
                    return self._cached
                self._retry_at = self._now() + RETRY_SECONDS
                return EMPTY
            self._cached = catalog
            self._fresh_until = self._now() + CACHE_SECONDS
            return catalog

    async def _fetch(self) -> Catalog:
        url = f"{self.config.api_url}/repos/{self.config.repo}/releases/latest"
        async with self.client() as client:
            response = await client.get(url, headers=self.api_headers())
            response.raise_for_status()
            release = response.json()
            if not isinstance(release, dict):
                raise ValueError("release is not an object")
            if release.get("draft") or release.get("prerelease"):
                raise ValueError("latest release is a draft or prerelease")
            tag = release.get("tag_name")
            version = tag[1:] if isinstance(tag, str) and tag.startswith("v") else tag
            if not isinstance(version, str) or not _SEMVER.match(version):
                raise ValueError("tag is not a version")
            published = release.get("published_at")
            published_at = (
                published if isinstance(published, str) and _ISO.match(published) else None
            )
            assets = [a for a in release.get("assets") or [] if isinstance(a, dict)]
            by_name = {a.get("name"): a for a in assets if isinstance(a.get("name"), str)}

            sums: dict[str, str] = {}
            if SUMS_NAME in by_name:
                text = await self._small_asset(client, by_name[SUMS_NAME])
                sums = parse_sums(text) if text is not None else {}
            signed = {"windows": False, "mac": False}
            if SIGNING_NAME in by_name:
                text = await self._small_asset(client, by_name[SIGNING_NAME])
                if text is not None:
                    signed = parse_signing(text)

        files: list[FileEntry] = []
        for platform in PLATFORMS:
            pattern = ASSET_PATTERNS[platform]
            for name, asset in sorted(by_name.items()):
                match = pattern.match(name)
                if not match or match.group("version") != version:
                    continue
                asset_id, size = asset.get("id"), asset.get("size")
                browser = asset.get("browser_download_url")
                if not isinstance(asset_id, int) or isinstance(asset_id, bool) or asset_id < 1:
                    continue
                if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                    continue
                if not isinstance(browser, str) or not self.browser_url_ok(browser, name):
                    continue
                if asset.get("state", "uploaded") != "uploaded":
                    continue
                files.append(
                    FileEntry(
                        platform=platform,
                        name=name,
                        size=size,
                        sha256=self._sha256(name, asset, sums),
                        asset_id=asset_id,
                        browser_url=browser,
                    )
                )
                break
        return Catalog(
            version=version, published_at=published_at, files=tuple(files), signed=signed
        )

    @staticmethod
    def _sha256(name: str, asset: Mapping[str, Any], sums: Mapping[str, str]) -> str | None:
        github, listed = _digest(asset), sums.get(name)
        if github and listed and github != listed:
            logger.warning("downloads.sha256.mismatch name=%s", name)
            return None
        return github or listed

    async def _small_asset(self, client: httpx.AsyncClient, asset: Mapping[str, Any]) -> str | None:
        """The text of SHA256SUMS.txt or signing.json; None when it cannot be read."""
        try:
            if self.config.token:
                asset_id = asset.get("id")
                if not isinstance(asset_id, int):
                    return None
                response = await client.get(
                    self.asset_api_url(asset_id),
                    headers=self.api_headers("application/octet-stream"),
                )
                if response.is_redirect:
                    # The signed storage address: fetched WITHOUT our token.
                    location = response.headers.get("location", "")
                    if not _plausible_location(location, self.config):
                        return None
                    response = await client.get(location, headers={"User-Agent": "trio-server"})
            else:
                url = asset.get("browser_download_url")
                if not isinstance(url, str) or not self.browser_url_ok(url, str(asset.get("name"))):
                    return None
                response = await client.get(
                    url, headers={"User-Agent": "trio-server"}, follow_redirects=True
                )
            response.raise_for_status()
            if len(response.content) > SMALL_ASSET_MAX_BYTES:
                return None
            return response.content.decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001 - a missing checksum is not a broken page
            logger.warning(
                "downloads.asset.failed name=%s %s", asset.get("name"), type(exc).__name__
            )
            return None


def _plausible_location(location: str, config: DownloadConfig) -> bool:
    """A redirect target we would send a visitor to: https, or the configured (test) hosts."""
    parts = urlsplit(location)
    if not parts.netloc or any(c in location for c in "\r\n "):
        return False
    if parts.scheme == "https":
        return True
    return location.startswith((config.api_url + "/", config.download_url + "/"))


_NO_STORE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}


def register_download_routes(
    app: FastAPI,
    config: DownloadConfig,
    *,
    now: Callable[[], float],
    http_transport: httpx.AsyncBaseTransport | None,
    static_dir: str | None,
    page_headers: Callable[[str], dict[str, str]],
    trusted_proxy_hops: int,
) -> DownloadCatalog:
    catalog = DownloadCatalog(config, now, http_transport)
    limiter = SlidingWindow(DOWNLOAD_ATTEMPTS, DOWNLOAD_WINDOW_SECONDS, now)
    app.state.downloads = catalog

    @app.get("/api/downloads")
    async def downloads() -> JSONResponse:
        return JSONResponse((await catalog.get()).public(), headers={"Cache-Control": "no-cache"})

    @app.get("/indir/dosya/{platform}")
    async def download_file(platform: str, request: Request) -> Response:
        if platform not in PLATFORMS:
            return error_response(404, "NOT_FOUND", "no such platform")
        address = client_address(request, trusted_proxy_hops)
        if not limiter.allow(address):
            return error_response(
                429,
                "RATE_LIMITED",
                "too many downloads",
                headers={"Retry-After": str(limiter.retry_after(address))},
            )
        entry = (await catalog.get()).file(platform)
        if entry is None:
            return error_response(404, "NOT_FOUND", "no file for this platform")
        if not config.token:
            return RedirectResponse(entry.browser_url, status_code=302, headers=_NO_STORE)
        return await _signed_redirect(catalog, entry)

    async def page(request: Request) -> Response:
        index = Path(static_dir) / "indir.html" if static_dir else None
        if index is None or not index.is_file():
            return error_response(404, "NOT_FOUND", "not found")
        html = absolute_preview_urls(index.read_text(encoding="utf-8"), page_origin(request))
        headers = page_headers(request.headers.get("host", ""))
        if request.method == "HEAD":
            return Response(
                status_code=200,
                media_type="text/html; charset=utf-8",
                headers={**headers, "Content-Length": str(len(html.encode("utf-8")))},
            )
        return HTMLResponse(html, headers=headers)

    app.add_api_route("/indir", page, methods=["GET", "HEAD"])

    async def to_page() -> Response:
        return RedirectResponse("/indir", status_code=302)

    for path in ("/download", "/download/", "/indir/", "/indir.html"):
        app.add_api_route(path, to_page, methods=["GET", "HEAD"])
    return catalog


# Link previews (WhatsApp, Telegram, Discord…) want absolute og:image/og:url.
# The page is static, so the server writes its own origin in front of the
# root-relative ones: only in <meta> content attributes that start with "/",
# and only from a Host that is a plain host[:port] (anything else leaves the
# page exactly as built). The scheme is X-Forwarded-Proto's first value when
# it is http or https (Railway's edge terminates TLS), else the request's own.
_PLAIN_HOST = re.compile(
    r"^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$"
)
_META_PATH = re.compile(r'(<meta\s[^>]*?content=")(/[^"/][^"]*|/)(")')


def page_origin(request: Request) -> str | None:
    host = request.headers.get("host", "")
    if not _PLAIN_HOST.match(host):
        return None
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    scheme = forwarded if forwarded in ("http", "https") else request.url.scheme
    if scheme not in ("http", "https"):
        return None
    return f"{scheme}://{host}"


def absolute_preview_urls(html: str, origin: str | None) -> str:
    if origin is None:
        return html
    return _META_PATH.sub(lambda m: f"{m.group(1)}{origin}{m.group(2)}{m.group(3)}", html)


async def _signed_redirect(catalog: DownloadCatalog, entry: FileEntry) -> Response:
    """A private repository: ask GitHub for the file's short-lived address.

    GitHub answers the asset API with a redirect to signed storage, or (it
    says either may happen) with the bytes themselves; those are relayed.
    """
    client = catalog.client(timeout=httpx.Timeout(TIMEOUT_SECONDS, read=60.0))
    upstream: httpx.Response | None = None
    try:
        request = client.build_request(
            "GET",
            catalog.asset_api_url(entry.asset_id),
            headers=catalog.api_headers("application/octet-stream"),
        )
        upstream = await client.send(request, stream=True)
        location = upstream.headers.get("location", "")
        if upstream.is_redirect and _plausible_location(location, catalog.config):
            return RedirectResponse(location, status_code=302, headers=_NO_STORE)
        if upstream.status_code == 200:
            return _relay(client, upstream, entry)
        logger.warning("downloads.file.failed status=%s", upstream.status_code)
    except Exception as exc:  # noqa: BLE001 - the visitor gets a 502, never a traceback
        logger.warning("downloads.file.failed %s", type(exc).__name__)
    if upstream is not None:
        await upstream.aclose()
    await client.aclose()
    return error_response(502, "DOWNLOAD_UNAVAILABLE", "the file could not be fetched")


def _relay(client: httpx.AsyncClient, upstream: httpx.Response, entry: FileEntry) -> Response:
    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    headers = dict(_NO_STORE)
    headers["Content-Disposition"] = f'attachment; filename="{entry.name}"'
    length = upstream.headers.get("content-length", "")
    if length.isdigit():
        headers["Content-Length"] = length
    return StreamingResponse(body(), media_type="application/octet-stream", headers=headers)
