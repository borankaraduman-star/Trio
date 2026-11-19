"""Configuration, read from the environment (see CONTRACT.md)."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_STUN_URLS = ("stun:stun.l.google.com:19302",)
_TEST_PUSH_ORIGIN = re.compile(r"^http://(127\.0\.0\.1|localhost):[0-9]{2,5}$")
# Set by Railway in every deployment: a test-only setting is refused there.
PRODUCTION_MARKERS = ("RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID")


class ConfigError(RuntimeError):
    """The environment does not describe a server that may start."""


@dataclass(frozen=True)
class Settings:
    invite_code: str
    db_path: str = "./trio.db"
    # Lowered from 10: set it to the real head count, so that a leaked invite
    # code cannot create accounts beyond the people you actually know.
    max_users: int = 5
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

    def __post_init__(self) -> None:
        if not self.invite_code:
            raise ConfigError("TRIO_INVITE_CODE is required")
        if self.max_users < 1:
            raise ConfigError("TRIO_MAX_USERS must be at least 1")
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
            f"cloudflare_turn={self.cloudflare_turn}, "
            f"test_push_service={self.test_push_service!r})"
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

        max_users = integer("TRIO_MAX_USERS", 5)
        max_upload_mb = integer("TRIO_MAX_UPLOAD_MB", 25)

        if "TRIO_STUN_URLS" in env:
            stun = tuple(u.strip() for u in env["TRIO_STUN_URLS"].split(",") if u.strip())
        else:
            stun = DEFAULT_STUN_URLS

        test_push = optional("TRIO_TEST_PUSH_SERVICE")
        if test_push is not None and any(env.get(m) for m in PRODUCTION_MARKERS):
            raise ConfigError("TRIO_TEST_PUSH_SERVICE is for tests and is refused on Railway")

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
        )
