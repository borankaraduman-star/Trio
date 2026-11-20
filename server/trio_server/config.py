"""Configuration, read from the environment (see CONTRACT.md)."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_STUN_URLS = ("stun:stun.l.google.com:19302",)
# CONTRACT-V10-GROUPS §2: the bounds of TRIO_VOICE_ROOM_MAX.
VOICE_ROOM_MIN = 2
VOICE_ROOM_CEILING = 16
# CONTRACT-V12-WATCHING §5: simultaneous screen shares in one voice room.
SCREEN_SHARES_MIN = 1
SCREEN_SHARES_CEILING = 16
_TEST_PUSH_ORIGIN = re.compile(r"^http://(127\.0\.0\.1|localhost):[0-9]{2,5}$")
# Set by Railway in every deployment: a test-only setting is refused there.
PRODUCTION_MARKERS = ("RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID")


_HTTPS_ORIGIN = re.compile(r"^https://[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?$")
_TEST_HTTP_ORIGIN = re.compile(r"^http://(127\.0\.0\.1|localhost):[0-9]{2,5}$")
RECOVERY_CODE_MIN = 24


def normalize_public_url(
    raw: str, *, allow_test_http: bool = False, name: str = "TRIO_PUBLIC_URL"
) -> str:
    """CONTRACT-V11-ADDRESS §1: a plain origin, lower-case host, no trailing slash."""
    value = raw.strip()
    if value.endswith("/"):
        value = value[:-1]
    scheme, sep, rest = value.partition("://")
    candidate = f"{scheme.lower()}{sep}{rest.lower()}"
    if _HTTPS_ORIGIN.match(candidate):
        return candidate
    if allow_test_http and _TEST_HTTP_ORIGIN.match(candidate):
        return candidate
    raise ConfigError(f"{name} must be a plain https origin such as https://trio.example.org")


class ConfigError(RuntimeError):
    """The environment does not describe a server that may start."""


@dataclass(frozen=True)
class Settings:
    invite_code: str
    db_path: str = "./trio.db"
    # Set it to the real head count, so that a leaked invite code cannot
    # create accounts beyond the people you actually know. CONTRACT-V10-GROUPS:
    # Trio is for a small group (up to 10-15 people); the default is 15.
    max_users: int = 15
    static_dir: str | None = None
    turn_host: str | None = None
    turn_secret: str | None = None
    stun_urls: tuple[str, ...] = DEFAULT_STUN_URLS
    upload_dir: str = "./uploads"
    max_upload_mb: int = 25
    cf_turn_key_id: str | None = None
    cf_turn_api_token: str | None = None
    # Stored bytes per user (all their uploads, on a message or not).
    user_quota_mb: int = 1024
    # Free space the uploads volume must keep; an upload that would eat into
    # it is refused with 507 instead of filling the disk for everybody.
    disk_reserve_mb: int = 200
    # How many reverse proxies append to X-Forwarded-For in front of the app:
    # the client address is the N-th entry from the right. 0 = ignore the
    # header and use the socket peer.
    trusted_proxy_hops: int = 1
    # CONTRACT-V6-PUSH: the VAPID ``sub`` claim (mailto: or https:); empty = the
    # app's own https origin as seen when the device subscribed.
    push_subject: str | None = None
    # TEST ONLY (CONTRACT-V6-PUSH §8): an http://127.0.0.1:<port> origin whose
    # endpoints are accepted without the push-service allowlist and the DNS
    # checks, so the e2e suite can run a fake push service. Refused on Railway.
    test_push_service: str | None = None
    # CONTRACT-V6-OPS §1: the owner's user name (matched like a join); None =
    # the active user with the lowest id.
    owner: str | None = None
    # CONTRACT-V10-GROUPS §2: people in one voice room at once. Voice is a full
    # mesh (everybody sends to everybody), so a room has an honest ceiling.
    voice_room_max: int = 8
    # CONTRACT-V12-WATCHING §5: people sharing a screen at once in one voice
    # room. Every share is encoded once per viewer (a mesh), and every viewer
    # decodes every share; past this a share is refused with who is sharing.
    screen_shares_max: int = 4
    # CONTRACT-V11-ADDRESS: the canonical address (a plain origin) and the
    # owner's recovery code; both None = off.
    public_url: str | None = None
    # The address the server will move to soon (the rename path): clients are
    # told beforehand, and a move code is redeemable there too.
    next_url: str | None = None
    recovery_code: str | None = None
    # TESTS ONLY: lets public_url be http://127.0.0.1|localhost:<port>.
    test_http_public_url: bool = False

    def __post_init__(self) -> None:
        if not self.invite_code:
            raise ConfigError("TRIO_INVITE_CODE is required")
        if self.max_users < 1:
            raise ConfigError("TRIO_MAX_USERS must be at least 1")
        if not VOICE_ROOM_MIN <= self.voice_room_max <= VOICE_ROOM_CEILING:
            raise ConfigError(
                f"TRIO_VOICE_ROOM_MAX must be between {VOICE_ROOM_MIN} and {VOICE_ROOM_CEILING}"
            )
        if not SCREEN_SHARES_MIN <= self.screen_shares_max <= SCREEN_SHARES_CEILING:
            raise ConfigError(
                "TRIO_SCREEN_SHARES_MAX must be between "
                f"{SCREEN_SHARES_MIN} and {SCREEN_SHARES_CEILING}"
            )
        if self.max_upload_mb < 1:
            raise ConfigError("TRIO_MAX_UPLOAD_MB must be at least 1")
        if self.user_quota_mb < 1:
            raise ConfigError("TRIO_USER_QUOTA_MB must be at least 1")
        if self.disk_reserve_mb < 0:
            raise ConfigError("TRIO_DISK_RESERVE_MB must not be negative")
        if not 0 <= self.trusted_proxy_hops <= 10:
            raise ConfigError("TRIO_TRUSTED_PROXY_HOPS must be between 0 and 10")
        if self.push_subject is not None and not (
            self.push_subject.startswith(("mailto:", "https://")) and " " not in self.push_subject
        ):
            raise ConfigError("TRIO_PUSH_SUBJECT must be a mailto: or https: URI")
        if self.test_push_service is not None and not _TEST_PUSH_ORIGIN.match(
            self.test_push_service
        ):
            raise ConfigError("TRIO_TEST_PUSH_SERVICE must be http://127.0.0.1:<port>")
        if self.public_url is not None and self.public_url != normalize_public_url(
            self.public_url, allow_test_http=self.test_http_public_url
        ):
            raise ConfigError("TRIO_PUBLIC_URL must be given normalised")
        if self.next_url is not None and self.next_url != normalize_public_url(
            self.next_url, allow_test_http=self.test_http_public_url, name="TRIO_NEXT_URL"
        ):
            raise ConfigError("TRIO_NEXT_URL must be given normalised")
        if self.recovery_code is not None and (
            len("".join(ch for ch in self.recovery_code if ch != "-")) < RECOVERY_CODE_MIN
            or any(ch.isspace() for ch in self.recovery_code)
        ):
            raise ConfigError(
                f"TRIO_RECOVERY_CODE must be at least {RECOVERY_CODE_MIN} characters, no spaces"
            )

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def user_quota_bytes(self) -> int:
        return self.user_quota_mb * 1024 * 1024

    @property
    def disk_reserve_bytes(self) -> int:
        return self.disk_reserve_mb * 1024 * 1024

    @property
    def cloudflare_turn(self) -> bool:
        return bool(self.cf_turn_key_id and self.cf_turn_api_token)

    # The dataclass repr would print the secrets; keep them out of any log line.
    def __repr__(self) -> str:
        return (
            f"Settings(db_path={self.db_path!r}, max_users={self.max_users}, "
            f"static_dir={self.static_dir!r}, turn_host={self.turn_host!r}, "
            f"stun_urls={self.stun_urls!r}, upload_dir={self.upload_dir!r}, "
            f"max_upload_mb={self.max_upload_mb}, user_quota_mb={self.user_quota_mb}, "
            f"disk_reserve_mb={self.disk_reserve_mb}, "
            f"trusted_proxy_hops={self.trusted_proxy_hops}, "
            f"cloudflare_turn={self.cloudflare_turn}, owner={self.owner!r}, "
            f"voice_room_max={self.voice_room_max}, "
            f"test_push_service={self.test_push_service!r}, "
            f"public_url={self.public_url!r}, next_url={self.next_url!r}, "
            f"recovery_code_set={self.recovery_code is not None}, "
            f"screen_shares_max={self.screen_shares_max})"
        )

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env

        def optional(name: str) -> str | None:
            value = env.get(name, "").strip()
            return value or None

        def integer(name: str, default: int) -> int:
            raw = env.get(name, "").strip() or str(default)
            try:
                return int(raw)
            except ValueError as exc:
                raise ConfigError(f"{name} must be an integer") from exc

        max_users = integer("TRIO_MAX_USERS", 15)
        max_upload_mb = integer("TRIO_MAX_UPLOAD_MB", 25)

        if "TRIO_STUN_URLS" in env:
            stun = tuple(u.strip() for u in env["TRIO_STUN_URLS"].split(",") if u.strip())
        else:
            stun = DEFAULT_STUN_URLS

        test_push = optional("TRIO_TEST_PUSH_SERVICE")
        if test_push is not None and any(env.get(m) for m in PRODUCTION_MARKERS):
            raise ConfigError("TRIO_TEST_PUSH_SERVICE is for tests and is refused on Railway")

        test_http = env.get("TRIO_TEST_HTTP_PUBLIC_URL", "").strip() == "1"
        if test_http and any(env.get(m) for m in PRODUCTION_MARKERS):
            raise ConfigError("TRIO_TEST_HTTP_PUBLIC_URL is for tests and is refused on Railway")
        raw_public = optional("TRIO_PUBLIC_URL")
        public_url = (
            None
            if raw_public is None
            else normalize_public_url(raw_public, allow_test_http=test_http)
        )
        raw_next = optional("TRIO_NEXT_URL")
        next_url = (
            None
            if raw_next is None
            else normalize_public_url(raw_next, allow_test_http=test_http, name="TRIO_NEXT_URL")
        )
        recovery = optional("TRIO_RECOVERY_CODE")

        return cls(
            invite_code=env.get("TRIO_INVITE_CODE", ""),
            db_path=optional("TRIO_DB_PATH") or "./trio.db",
            max_users=max_users,
            static_dir=optional("TRIO_STATIC_DIR"),
            turn_host=optional("TRIO_TURN_HOST"),
            turn_secret=optional("TRIO_TURN_SECRET"),
            stun_urls=stun,
            upload_dir=optional("TRIO_UPLOAD_DIR") or "./uploads",
            max_upload_mb=max_upload_mb,
            cf_turn_key_id=optional("TRIO_CF_TURN_KEY_ID"),
            cf_turn_api_token=optional("TRIO_CF_TURN_API_TOKEN"),
            user_quota_mb=integer("TRIO_USER_QUOTA_MB", 1024),
            disk_reserve_mb=integer("TRIO_DISK_RESERVE_MB", 200),
            trusted_proxy_hops=integer("TRIO_TRUSTED_PROXY_HOPS", 1),
            push_subject=optional("TRIO_PUSH_SUBJECT"),
            test_push_service=test_push,
            owner=optional("TRIO_OWNER"),
            voice_room_max=integer("TRIO_VOICE_ROOM_MAX", 8),
            screen_shares_max=integer("TRIO_SCREEN_SHARES_MAX", 4),
            public_url=public_url,
            next_url=next_url,
            recovery_code=recovery,
            test_http_public_url=test_http,
        )
