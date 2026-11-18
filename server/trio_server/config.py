"""Configuration, read from the environment (see CONTRACT.md)."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_STUN_URLS = ("stun:stun.l.google.com:19302",)


class ConfigError(RuntimeError):
    """The environment does not describe a server that may start."""


@dataclass(frozen=True)
class Settings:
    invite_code: str
    db_path: str = "./trio.db"
    max_users: int = 10
    static_dir: str | None = None
    turn_host: str | None = None
    turn_secret: str | None = None
    stun_urls: tuple[str, ...] = DEFAULT_STUN_URLS
    upload_dir: str = "./uploads"
    max_upload_mb: int = 25
    cf_turn_key_id: str | None = None
    cf_turn_api_token: str | None = None

    def __post_init__(self) -> None:
        if not self.invite_code:
            raise ConfigError("TRIO_INVITE_CODE is required")
        if self.max_users < 1:
            raise ConfigError("TRIO_MAX_USERS must be at least 1")
        if self.max_upload_mb < 1:
            raise ConfigError("TRIO_MAX_UPLOAD_MB must be at least 1")

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def cloudflare_turn(self) -> bool:
        return bool(self.cf_turn_key_id and self.cf_turn_api_token)

    # The dataclass repr would print the secrets; keep them out of any log line.
    def __repr__(self) -> str:
        return (
            f"Settings(db_path={self.db_path!r}, max_users={self.max_users}, "
            f"static_dir={self.static_dir!r}, turn_host={self.turn_host!r}, "
            f"stun_urls={self.stun_urls!r}, upload_dir={self.upload_dir!r}, "
            f"max_upload_mb={self.max_upload_mb}, cloudflare_turn={self.cloudflare_turn})"
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

        max_users = integer("TRIO_MAX_USERS", 10)
        max_upload_mb = integer("TRIO_MAX_UPLOAD_MB", 25)

        if "TRIO_STUN_URLS" in env:
            stun = tuple(u.strip() for u in env["TRIO_STUN_URLS"].split(",") if u.strip())
        else:
            stun = DEFAULT_STUN_URLS

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
        )
