"""Web Push cryptography: RFC 8291 payload encryption and RFC 8292 VAPID.

Implemented on ``cryptography`` instead of pulling in pywebpush: pywebpush
brings ``requests``/``aiohttp``, ``py-vapid`` and ``http-ece`` and does its own
HTTP, while every request this server makes must go through the app's httpx
transport (tests, the SSRF rules in ``push.py``). The pieces here are small
and each is checked by a round trip in the tests (``tests/test_v6_push*.py``):
the ciphertext is decrypted with the subscription's own private key and the
JWT is verified with the public key.

RFC 8291 (``aes128gcm``, one record, RFC 8188)::

    ecdh   = ECDH(as_private, ua_public)
    ikm    = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\\0" || ua_public || as_public, 32)
    cek    = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: aes128gcm\\0", 16)
    nonce  = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: nonce\\0", 12)
    body   = salt(16) || rs(4, BE) || idlen(1)=65 || as_public(65)
             || AES-128-GCM(cek, nonce, plaintext || 0x02)
"""

from __future__ import annotations

import base64
import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

RECORD_SIZE = 4096
HEADER_BYTES = 16 + 4 + 1 + 65
# Push services must accept at least 4096 bytes of body (RFC 8030 §7.2); one
# record carries plaintext + 1 delimiter byte + 16 tag bytes after the header.
MAX_PLAINTEXT = RECORD_SIZE - HEADER_BYTES - 1 - 16


class PushCryptoError(ValueError):
    pass


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    if not isinstance(text, str) or not text or len(text) > 1024:
        raise PushCryptoError("not base64url")
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (ValueError, TypeError) as exc:
        raise PushCryptoError("not base64url") from exc


def _hkdf(salt: bytes, ikm: bytes, info: bytes, length: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def public_point(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )


def load_point(raw: bytes) -> ec.EllipticCurvePublicKey:
    """A P-256 public key from its 65-byte uncompressed form (a subscription's ``p256dh``)."""
    if len(raw) != 65 or raw[0] != 4:
        raise PushCryptoError("p256dh must be an uncompressed P-256 point")
    try:
        return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError as exc:
        raise PushCryptoError("p256dh is not a point on P-256") from exc


def check_subscription_keys(p256dh: str, auth: str) -> tuple[bytes, bytes]:
    """The decoded keys of a subscription, or PushCryptoError."""
    point = b64url_decode(p256dh)
    load_point(point)
    secret = b64url_decode(auth)
    if len(secret) != 16:
        raise PushCryptoError("auth must be 16 bytes")
    return point, secret


def encrypt(
    plaintext: bytes,
    ua_public: bytes,
    auth_secret: bytes,
    *,
    _private: ec.EllipticCurvePrivateKey | None = None,
    _salt: bytes | None = None,
) -> bytes:
    """The ``aes128gcm`` body for one push message (RFC 8291)."""
    if len(plaintext) > MAX_PLAINTEXT:
        raise PushCryptoError("payload is too large")
    receiver = load_point(ua_public)
    private = _private or ec.generate_private_key(ec.SECP256R1())
    as_public = public_point(private.public_key())
    salt = _salt or os.urandom(16)
    shared = private.exchange(ec.ECDH(), receiver)
    ikm = _hkdf(auth_secret, shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    ciphertext = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)
    header = salt + RECORD_SIZE.to_bytes(4, "big") + bytes([len(as_public)]) + as_public
    return header + ciphertext


def decrypt(body: bytes, ua_private: ec.EllipticCurvePrivateKey, auth_secret: bytes) -> bytes:
    """What a browser does with ``encrypt``'s output; used by the tests."""
    if len(body) < HEADER_BYTES + 17:
        raise PushCryptoError("body too short")
    salt, idlen = body[:16], body[20]
    as_public = body[21 : 21 + idlen]
    ciphertext = body[21 + idlen :]
    ua_public = public_point(ua_private.public_key())
    shared = ua_private.exchange(ec.ECDH(), load_point(as_public))
    ikm = _hkdf(auth_secret, shared, b"WebPush: info\x00" + ua_public + as_public, 32)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    padded = AESGCM(cek).decrypt(nonce, ciphertext, None)
    end = padded.rstrip(b"\x00")
    if not end.endswith(b"\x02"):
        raise PushCryptoError("missing last-record delimiter")
    return end[:-1]


# -- VAPID (RFC 8292) ----------------------------------------------------------

# Apple: the expiry may be at most a day ahead, and the JWT should not be
# renewed more often than once an hour. 12 h, renewed after 6 h.
JWT_LIFETIME_SECONDS = 12 * 3600
JWT_RENEW_AFTER_SECONDS = 6 * 3600


@dataclass
class VapidKey:
    private: ec.EllipticCurvePrivateKey

    @classmethod
    def generate(cls) -> VapidKey:
        return cls(ec.generate_private_key(ec.SECP256R1()))

    @classmethod
    def from_pem(cls, pem: str) -> VapidKey:
        key = serialization.load_pem_private_key(pem.encode("ascii"), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
            raise PushCryptoError("the stored VAPID key is not a P-256 key")
        return cls(key)

    def pem(self) -> str:
        return self.private.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii")

    @property
    def public_b64(self) -> str:
        """The ``applicationServerKey`` a browser subscribes with (and ``k=``)."""
        return b64url(public_point(self.private.public_key()))

    def jwt(self, audience: str, subject: str, now: float) -> str:
        header = b64url(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
        claims = {"aud": audience, "exp": int(now) + JWT_LIFETIME_SECONDS, "sub": subject}
        body = b64url(json.dumps(claims, separators=(",", ":")).encode())
        signing_input = f"{header}.{body}".encode("ascii")
        der = self.private.sign(signing_input, ec.ECDSA(hashes.SHA256()))
        r, s = decode_dss_signature(der)
        signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        return f"{header}.{body}.{b64url(signature)}"


def verify_jwt(token: str, public_b64: str) -> dict[str, object]:
    """Check an ES256 JWT against a raw public key; the claims. Tests use it."""
    header, body, signature = token.split(".")
    raw = b64url_decode(signature)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    key = load_point(b64url_decode(public_b64))
    key.verify(der, f"{header}.{body}".encode("ascii"), ec.ECDSA(hashes.SHA256()))
    if json.loads(b64url_decode(header)) != {"typ": "JWT", "alg": "ES256"}:
        raise PushCryptoError("unexpected JWT header")
    return json.loads(b64url_decode(body))


class JwtCache:
    """One JWT per (audience, subject), reused for JWT_RENEW_AFTER_SECONDS."""

    def __init__(self, key: VapidKey, now: Callable[[], float] = time.time) -> None:
        self.key = key
        self.now = now
        self._cache: dict[tuple[str, str], tuple[float, str]] = {}

    def header(self, audience: str, subject: str) -> str:
        now = self.now()
        cached = self._cache.get((audience, subject))
        if cached is None or now - cached[0] >= JWT_RENEW_AFTER_SECONDS:
            cached = (now, self.key.jwt(audience, subject, now))
            if len(self._cache) > 64:
                self._cache.clear()
            self._cache[(audience, subject)] = cached
        return f"vapid t={cached[1]}, k={self.key.public_b64}"
