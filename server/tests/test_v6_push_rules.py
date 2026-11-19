"""CONTRACT-V6-PUSH, the pure parts: crypto, the allowlist, mentions, quiet hours, decisions."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from trio_server.config import ConfigError, Settings
from trio_server.mentions import find_mentions, mentioned_users
from trio_server.notify import (
    PrefsError,
    Situation,
    decide,
    default_prefs,
    in_quiet_hours,
    merge_prefs,
    message_payload,
)
from trio_server.push import (
    ALLOWED_PUSH_HOSTS,
    EndpointError,
    PrivateAddressError,
    check_endpoint_shape,
    host_allowed,
    public_address,
    resolve_target,
)
from trio_server.push_crypto import (
    MAX_PLAINTEXT,
    JwtCache,
    PushCryptoError,
    VapidKey,
    b64url,
    b64url_decode,
    check_subscription_keys,
    decrypt,
    encrypt,
    public_point,
    verify_jwt,
)

CASES = Path(__file__).resolve().parents[2] / "web/src/lib/notify/mentionCases.json"


# -- RFC 8291 / 8292 -------------------------------------------------------------------


def _browser_keys():
    private = ec.generate_private_key(ec.SECP256R1())
    return private, public_point(private.public_key()), b"0123456789abcdef"


def test_encrypt_round_trips_with_the_subscriptions_own_keys():
    private, public, auth = _browser_keys()
    body = encrypt(b'{"title":"Mehmet"}', public, auth)
    assert body[16:20] == (4096).to_bytes(4, "big")
    assert body[20] == 65
    assert decrypt(body, private, auth) == b'{"title":"Mehmet"}'


def test_rfc8291_appendix_a_vector():
    """The worked example of RFC 8291 Appendix A, byte for byte."""
    ua_private = ec.derive_private_key(
        int.from_bytes(b64url_decode("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"), "big"),
        ec.SECP256R1(),
    )
    as_private = ec.derive_private_key(
        int.from_bytes(b64url_decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"),
        ec.SECP256R1(),
    )
    auth = b64url_decode("BTBZMqHH6r4Tts7J_aSIgg")
    salt = b64url_decode("DGv6ra1nlYgDCS1FRnbzlw")
    body = encrypt(
        b"When I grow up, I want to be a watermelon",
        public_point(ua_private.public_key()),
        auth,
        _private=as_private,
        _salt=salt,
    )
    assert b64url(body) == (
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWA"
        "mS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
    )
    assert decrypt(body, ua_private, auth) == b"When I grow up, I want to be a watermelon"


def test_the_largest_payload_fits_the_4096_byte_body_and_one_more_byte_is_refused():
    _, public, auth = _browser_keys()
    assert len(encrypt(b"x" * MAX_PLAINTEXT, public, auth)) == 4096
    with pytest.raises(PushCryptoError):
        encrypt(b"x" * (MAX_PLAINTEXT + 1), public, auth)


def test_subscription_keys_are_checked():
    _, public, auth = _browser_keys()
    check_subscription_keys(b64url(public), b64url(auth))
    with pytest.raises(PushCryptoError):
        check_subscription_keys(b64url(public[:-1]), b64url(auth))
    with pytest.raises(PushCryptoError):
        check_subscription_keys(b64url(b"\x04" + b"\x00" * 64), b64url(auth))  # not on the curve
    with pytest.raises(PushCryptoError):
        check_subscription_keys(b64url(public), b64url(b"short"))
    with pytest.raises(PushCryptoError):
        check_subscription_keys(12, b64url(auth))  # type: ignore[arg-type]


def test_vapid_jwt_verifies_and_carries_the_claims():
    key = VapidKey.generate()
    token = key.jwt("https://fcm.googleapis.com", "mailto:a@b.example", 1_800_000_000)
    claims = verify_jwt(token, key.public_b64)
    assert claims == {
        "aud": "https://fcm.googleapis.com",
        "exp": 1_800_000_000 + 12 * 3600,
        "sub": "mailto:a@b.example",
    }
    other = VapidKey.generate()
    with pytest.raises(Exception):  # noqa: B017 - InvalidSignature
        verify_jwt(token, other.public_b64)


def test_the_vapid_key_survives_pem():
    key = VapidKey.generate()
    assert VapidKey.from_pem(key.pem()).public_b64 == key.public_b64
    assert len(b64url_decode(key.public_b64)) == 65


def test_the_jwt_is_reused_for_six_hours_then_renewed():
    clock = [1_800_000_000.0]
    cache = JwtCache(VapidKey.generate(), lambda: clock[0])
    first = cache.header("https://a.push.apple.com", "mailto:x@y.example")
    clock[0] += 5 * 3600
    assert cache.header("https://a.push.apple.com", "mailto:x@y.example") == first
    clock[0] += 3600
    assert cache.header("https://a.push.apple.com", "mailto:x@y.example") != first
    assert first.startswith("vapid t=") and ", k=" in first


# -- the endpoint allowlist and SSRF --------------------------------------------------


def test_the_allowlist_is_exactly_the_four_push_services():
    assert ALLOWED_PUSH_HOSTS == (
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
        ".notify.windows.com",
        ".push.apple.com",
    )


@pytest.mark.parametrize(
    "host,allowed",
    [
        ("fcm.googleapis.com", True),
        ("FCM.googleapis.com.", True),
        ("updates.push.services.mozilla.com", True),
        ("wns2-db5p.notify.windows.com", True),
        ("web.push.apple.com", True),
        ("notify.windows.com", False),
        ("push.apple.com", False),
        (".push.apple.com", False),
        ("fcm.googleapis.com.evil.example", False),
        ("evilfcm.googleapis.com", False),
        ("xpush.apple.com", False),
        ("localhost", False),
    ],
)
def test_host_allowed(host, allowed):
    assert host_allowed(host) is allowed


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/x",
        "https://fcm.googleapis.com:8443/fcm/send/x",
        "https://user:pw@fcm.googleapis.com/fcm/send/x",
        "https://evil.example@fcm.googleapis.com/x",
        "https://evil.example/fcm.googleapis.com",
        "https://127.0.0.1/x",
        "https://[::1]/x",
        "https://fcm.googleapis.com\\@evil.example/x",
        "https://fcm.googleapis.com/x y",
        "ftp://fcm.googleapis.com/x",
        "",
        "x" * 3000,
        42,
    ],
)
def test_endpoints_that_are_refused(endpoint):
    with pytest.raises(EndpointError):
        check_endpoint_shape(endpoint)


def test_the_test_service_is_only_its_own_origin():
    check_endpoint_shape("http://127.0.0.1:9999/push/a", "http://127.0.0.1:9999")
    with pytest.raises(EndpointError):
        check_endpoint_shape("http://127.0.0.1:9998/push/a", "http://127.0.0.1:9999")
    with pytest.raises(EndpointError):
        check_endpoint_shape("http://127.0.0.1:9999/push/a")


@pytest.mark.parametrize(
    "address,public",
    [
        ("142.250.184.10", True),
        ("2a00:1450:4017:80b::200a", True),
        ("10.0.0.1", False),
        ("172.16.5.4", False),
        ("192.168.1.1", False),
        ("127.0.0.1", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),
        ("0.0.0.0", False),  # noqa: S104 - an address checked, nothing binds
        ("::1", False),
        ("::ffff:127.0.0.1", False),
        ("::ffff:10.1.2.3", False),
        ("fe80::1%eth0", False),
        ("fd00::1", False),
        ("224.0.0.1", False),
        ("not-an-ip", False),
    ],
)
def test_public_address(address, public):
    assert public_address(address) is public


def _resolver(*answers):
    calls = []

    async def resolve(host, port):
        calls.append((host, port))
        return list(answers[min(len(calls), len(answers)) - 1])

    resolve.calls = calls
    return resolve


def test_the_request_goes_to_the_checked_address_with_the_name_kept():
    resolve = _resolver(["142.250.184.10", "10.0.0.1"])
    with pytest.raises(PrivateAddressError):
        asyncio.run(resolve_target("https://fcm.googleapis.com/fcm/send/abc", resolve, None))
    resolve = _resolver(["142.250.184.10"])
    target = asyncio.run(
        resolve_target("https://fcm.googleapis.com/fcm/send/abc?x=1", resolve, None)
    )
    assert target.url == "https://142.250.184.10/fcm/send/abc?x=1"
    assert target.host == "fcm.googleapis.com"
    assert target.audience == "https://fcm.googleapis.com"
    assert resolve.calls == [("fcm.googleapis.com", 443)]
    v6 = asyncio.run(
        resolve_target("https://web.push.apple.com/Q", _resolver(["2a00:1450::1"]), None)
    )
    assert v6.url == "https://[2a00:1450::1]/Q"


def test_a_rebinding_answer_is_refused_on_every_send():
    """Public at subscribe (only the name is checked then), private when sending."""
    endpoint = "https://fcm.googleapis.com/fcm/send/abc"
    check_endpoint_shape(endpoint)
    resolve = _resolver(["142.250.184.10"], ["127.0.0.1"], ["::ffff:169.254.169.254"], [])
    assert asyncio.run(resolve_target(endpoint, resolve, None)).url.startswith("https://142.")
    for _ in range(3):
        with pytest.raises(PrivateAddressError):
            asyncio.run(resolve_target(endpoint, resolve, None))


def test_the_test_only_setting_is_refused_on_railway():
    env = {"TRIO_INVITE_CODE": "x", "TRIO_TEST_PUSH_SERVICE": "http://127.0.0.1:9000"}
    assert Settings.from_env(env).test_push_service == "http://127.0.0.1:9000"
    for marker in ("RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID"):
        with pytest.raises(ConfigError):
            Settings.from_env({**env, marker: "production"})
    for bad in ("http://10.0.0.1:9000", "https://127.0.0.1:9000", "http://127.0.0.1"):
        with pytest.raises(ConfigError):
            Settings.from_env({**env, "TRIO_TEST_PUSH_SERVICE": bad})
    with pytest.raises(ConfigError):
        Settings.from_env({"TRIO_INVITE_CODE": "x", "TRIO_PUSH_SUBJECT": "admin@example.com"})


# -- mentions (the fixture is shared with web/src/lib/notify/mentions.test.ts) --------


def _cases():
    return json.loads(CASES.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["text"])
def test_mention_cases_shared_with_the_client(case):
    import unicodedata

    names = {int(k): v for k, v in case["names"].items()}
    named, everyone = mentioned_users(case["text"], names)
    assert sorted(named) == case["mentioned"]
    assert everyone is case["everyone"]
    nfc = unicodedata.normalize("NFC", case["text"])
    assert [nfc[s:e] for s, e, _ in find_mentions(case["text"], names)] == case["spans"]


# -- quiet hours --------------------------------------------------------------------


def _at(text: str, zone: str) -> float:
    return datetime.fromisoformat(text).replace(tzinfo=ZoneInfo(zone)).timestamp()


QUIET = {"enabled": True, "start": "23:00", "end": "08:00", "tz": "Europe/Istanbul"}


@pytest.mark.parametrize(
    "local,inside",
    [
        ("2026-11-19T22:59", False),
        ("2026-11-19T23:00", True),
        ("2026-11-20T00:30", True),
        ("2026-11-20T07:59", True),
        ("2026-11-20T08:00", False),
        ("2026-11-20T12:00", False),
    ],
)
def test_quiet_hours_across_midnight_in_istanbul(local, inside):
    assert in_quiet_hours(QUIET, _at(local, "Europe/Istanbul")) is inside


def test_quiet_hours_follow_the_wall_clock_across_dst_in_berlin():
    quiet = {**QUIET, "start": "01:30", "end": "03:30", "tz": "Europe/Berlin"}
    # 2026-03-29: 02:00 -> 03:00 (CET -> CEST). 01:45 and 03:15 local are inside.
    assert in_quiet_hours(quiet, _at("2026-03-29T01:45", "Europe/Berlin"))
    assert in_quiet_hours(quiet, _at("2026-03-29T03:15", "Europe/Berlin"))
    assert not in_quiet_hours(quiet, _at("2026-03-29T03:31", "Europe/Berlin"))
    # 2026-10-25: 03:00 -> 02:00; both 02:30s are inside.
    first = _at("2026-10-25T02:30", "Europe/Berlin")
    assert in_quiet_hours(quiet, first) and in_quiet_hours(quiet, first + 3600)
    # The same instant is 04:30 in Istanbul (no DST since 2016): outside there.
    assert not in_quiet_hours({**quiet, "tz": "Europe/Istanbul"}, first + 3600)


def test_quiet_hours_off_or_empty_range():
    now = _at("2026-11-20T01:00", "Europe/Istanbul")
    assert not in_quiet_hours({**QUIET, "enabled": False}, now)
    assert not in_quiet_hours({**QUIET, "start": "05:00", "end": "05:00"}, now)
    assert in_quiet_hours({**QUIET, "start": "00:00", "end": "02:00"}, now)


# -- preferences --------------------------------------------------------------------


def test_prefs_merge_and_validation():
    prefs = merge_prefs(default_prefs(), {"channels": {"1": "mentions", "2": "none"}}, {1, 2})
    assert prefs["channels"] == {"1": "mentions", "2": "none"}
    prefs = merge_prefs(prefs, {"channels": {"2": None, "1": "all"}}, {1, 2})
    assert prefs["channels"] == {}
    prefs = merge_prefs(prefs, {"quiet": {"enabled": True, "tz": "America/New_York"}}, {1})
    assert prefs["quiet"] == {
        "enabled": True,
        "start": "23:00",
        "end": "08:00",
        "tz": "America/New_York",
    }
    for bad in (
        {"channels": {"9": "all"}},
        {"channels": {"1": "loud"}},
        {"channels": []},
        {"quiet": {"start": "24:00"}},
        {"quiet": {"start": "7:00"}},
        {"quiet": {"tz": "Mars/Base"}},
        {"quiet": {"tz": "../../etc/passwd"}},
        {"quiet": {"enabled": "yes"}},
        {"quiet": {"volume": 3}},
        {"calls": 1},
        {"color": "red"},
    ):
        with pytest.raises(PrefsError):
            merge_prefs(default_prefs(), bad, {1})


# -- the decision table ---------------------------------------------------------------

# (situation fields, push?, why). Every row of CONTRACT-V6-PUSH §5.
MATRIX = [
    # message: own, viewing, levels, quiet, mention
    ({"kind": "message"}, True, "message"),
    ({"kind": "message", "own": True}, False, "own"),
    ({"kind": "message", "own": True, "mention": True}, False, "own"),
    ({"kind": "message", "viewing": True}, False, "viewing"),
    ({"kind": "message", "viewing": True, "mention": True}, False, "viewing"),
    ({"kind": "message", "level": "mentions"}, False, "level-mentions"),
    ({"kind": "message", "level": "mentions", "mention": True}, True, "mention"),
    ({"kind": "message", "level": "none"}, False, "level-none"),
    ({"kind": "message", "level": "none", "mention": True}, False, "level-none"),
    ({"kind": "message", "quiet": True}, False, "quiet"),
    ({"kind": "message", "quiet": True, "mention": True}, True, "mention"),
    ({"kind": "message", "quiet": True, "level": "mentions", "mention": True}, True, "mention"),
    ({"kind": "message", "quiet": True, "level": "none", "mention": True}, False, "level-none"),
    # voice room opened
    ({"kind": "voice"}, True, "voice"),
    ({"kind": "voice", "own": True}, False, "own"),
    ({"kind": "voice", "viewing": True}, False, "viewing"),
    ({"kind": "voice", "in_voice": True}, False, "in-voice"),
    ({"kind": "voice", "quiet": True}, False, "quiet"),
    ({"kind": "voice", "voice_rooms": False}, False, "voice-off"),
    ({"kind": "voice", "level": "none"}, False, "level-none"),
    ({"kind": "voice", "level": "mentions"}, False, "level-mentions"),
    # ring
    ({"kind": "ring"}, True, "ring"),
    ({"kind": "ring", "own": True}, False, "own"),
    ({"kind": "ring", "viewing": True}, False, "viewing"),
    ({"kind": "ring", "in_voice": True}, False, "in-voice"),
    ({"kind": "ring", "calls": False}, False, "calls-off"),
    ({"kind": "ring", "quiet": True}, False, "quiet"),
    ({"kind": "ring", "quiet": True, "calls_break_quiet": True}, True, "ring"),
    ({"kind": "ring", "level": "none"}, True, "ring"),  # a ring has no channel level
]


@pytest.mark.parametrize("fields,push,why", MATRIX, ids=lambda v: str(v))
def test_decision_matrix(fields, push, why):
    assert decide(Situation(**fields)) == (push, why)


# -- payloads -----------------------------------------------------------------------


def _message(content="", attachments=()):
    return {
        "id": 7,
        "channel_id": 3,
        "content": content,
        "author": {"id": 1, "name": "Mehmet"},
        "attachments": list(attachments),
    }


def test_message_payloads():
    payload = message_payload(_message("selam\n  nasılsın"), "genel")
    assert payload["title"] == "Mehmet — #genel"
    assert payload["body"] == "selam nasılsın"
    assert payload["tag"] == "ch-3" and payload["message_id"] == 7
    long = message_payload(_message("ş" * 4000), "genel")["body"]
    assert len(long) == 120 and long.endswith("…")
    image = {"content_type": "image/png"}
    audio = {"content_type": "audio/webm"}
    other = {"content_type": "application/pdf"}
    assert message_payload(_message("", [image]), "g")["body"] == "📎 fotoğraf"
    assert message_payload(_message("", [audio]), "g")["body"] == "🎤 sesli mesaj"
    assert message_payload(_message("", [image, other]), "g")["body"] == "📎 dosya"


def test_the_largest_message_payload_fits():
    payload = message_payload(
        {**_message("𝔸" * 4000), "author": {"id": 1, "name": "Ç" * 32}}, "Ş" * 32
    )
    data = json.dumps({**payload, "kind": "mention", "renotify": True}, ensure_ascii=False)
    assert len(data.encode()) < MAX_PLAINTEXT // 4
