"""ICE servers for /api/ice: Cloudflare Realtime TURN, else coturn, else STUN only.

Cloudflare's credential API (as documented for Realtime TURN):

    POST https://rtc.live.cloudflare.com/v1/turn/keys/<key id>/credentials/generate-ice-servers
    Authorization: Bearer <api token>
    {"ttl": 86400}
    -> {"iceServers": [{"urls": [...stun...]}, {"urls": [...turn...], "username", "credential"}]}

The older ``.../credentials/generate`` answers ``iceServers`` as ONE object
instead of a list; both shapes are read. URLs on port 53 are dropped: browsers
block that port, and an ICE agent without trickle would wait for it to time out.

The answer is cached for an hour (the credentials live 24). Any failure is a
warning without the token and an answer of STUN (and coturn, if configured)
only; a failure is remembered for a minute so a Cloudflare outage does not
cost every voice join a timeout.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import re
from collections.abc import Callable
from typing import Any

import httpx

from trio_server.config import Settings

logger = logging.getLogger("trio")

CLOUDFLARE_API = (
    "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
)
CLOUDFLARE_TTL_SECONDS = 24 * 60 * 60
CACHE_SECONDS = 60 * 60
FAILURE_BACKOFF_SECONDS = 60
TIMEOUT_SECONDS = 5.0
COTURN_TTL_SECONDS = 12 * 60 * 60

_PORT_53 = re.compile(r"^[a-z]+:[^?]*:53(\?|$)", re.IGNORECASE)


class CloudflareError(Exception):
    pass


def _clean_cloudflare(payload: Any) -> list[dict[str, Any]]:
    """The answer's iceServers, validated, port 53 removed. Raises on anything odd."""
    if not isinstance(payload, dict):
        raise CloudflareError("answer is not an object")
    servers = payload.get("iceServers")
    if isinstance(servers, dict):
        servers = [servers]
    if not isinstance(servers, list) or not servers:
        raise CloudflareError("answer has no iceServers")
    cleaned: list[dict[str, Any]] = []
    for server in servers:
        if not isinstance(server, dict):
            raise CloudflareError("iceServers entry is not an object")
        urls = server.get("urls")
        if isinstance(urls, str):
            urls = [urls]
        if not isinstance(urls, list) or not all(isinstance(u, str) for u in urls):
            raise CloudflareError("iceServers entry has no urls")
        urls = [u for u in urls if not _PORT_53.match(u)]
        if not urls:
            continue
        entry: dict[str, Any] = {"urls": urls}
        for key in ("username", "credential"):
            if key in server:
                if not isinstance(server[key], str):
                    raise CloudflareError(f"iceServers entry has a non-string {key}")
                entry[key] = server[key]
        cleaned.append(entry)
    if not any(
        u.startswith(("turn:", "turns:")) and "credential" in s for s in cleaned for u in s["urls"]
    ):
        raise CloudflareError("answer has no TURN server")
    return cleaned


class IceProvider:
    def __init__(
        self,
        settings: Settings,
        now: Callable[[], float],
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings
        self._now = now
        self._transport = transport
        self._cached: list[dict[str, Any]] | None = None
        self._cached_until = 0.0
        self._failed_until = 0.0
        self._lock = asyncio.Lock()

    def _stun(self) -> list[dict[str, Any]]:
        return [{"urls": list(self._settings.stun_urls)}] if self._settings.stun_urls else []

    def _coturn(self, user_id: int) -> list[dict[str, Any]]:
        settings = self._settings
        if not (settings.turn_host and settings.turn_secret):
            return []
        # coturn's use-auth-secret scheme: the credential is derived, so the
        # shared secret itself never leaves the server.
        username = f"{int(self._now()) + COTURN_TTL_SECONDS}:{user_id}"
        digest = hmac.new(
            settings.turn_secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1
        ).digest()
        host = settings.turn_host
        return [
            {
                "urls": [
                    f"turn:{host}:3478?transport=udp",
                    f"turn:{host}:3478?transport=tcp",
                    f"turns:{host}:5349?transport=tcp",
                ],
                "username": username,
                "credential": base64.b64encode(digest).decode("ascii"),
            }
        ]

    async def _cloudflare(self) -> list[dict[str, Any]] | None:
        now = self._now()
        if self._cached is not None and now < self._cached_until:
            return self._cached
        if now < self._failed_until:
            return None
        async with self._lock:
            now = self._now()
            if self._cached is not None and now < self._cached_until:
                return self._cached
            if now < self._failed_until:
                return None
            try:
                servers = await self._fetch()
            except Exception as exc:  # noqa: BLE001 - the endpoint never fails
                # The exception's text can quote the request; the type and the
                # status are enough, and never carry the token.
                detail = type(exc).__name__
                if isinstance(exc, httpx.HTTPStatusError):
                    detail += f" status={exc.response.status_code}"
                logger.warning("ice.cloudflare.failed %s; answering without TURN", detail)
                self._cached = None
                self._failed_until = self._now() + FAILURE_BACKOFF_SECONDS
                return None
            self._cached = servers
            self._cached_until = self._now() + CACHE_SECONDS
            return servers

    async def _fetch(self) -> list[dict[str, Any]]:
        settings = self._settings
        url = CLOUDFLARE_API.format(key_id=settings.cf_turn_key_id)
        async with httpx.AsyncClient(transport=self._transport, timeout=TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {settings.cf_turn_api_token}"},
                json={"ttl": CLOUDFLARE_TTL_SECONDS},
            )
            response.raise_for_status()
            return _clean_cloudflare(response.json())

    async def ice_servers(self, user_id: int) -> list[dict[str, Any]]:
        if self._settings.cloudflare_turn:
            cloudflare = await self._cloudflare()
            if cloudflare is not None:
                return self._stun() + cloudflare
            return self._stun()
        return self._stun() + self._coturn(user_id)
