from __future__ import annotations

import json
import logging

import httpx
import pytest

from trio_server.config import Settings

STUN = {"urls": ["stun:stun.l.google.com:19302"]}
CF = {"cf_turn_key_id": "key-123", "cf_turn_api_token": "SECRET-TOKEN-xyz"}

CF_ANSWER = {
    "iceServers": [
        {"urls": ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"]},
        {
            "urls": [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:53?transport=udp",
                "turn:turn.cloudflare.com:3478?transport=tcp",
                "turns:turn.cloudflare.com:5349?transport=tcp",
                "turn:turn.cloudflare.com:80?transport=tcp",
                "turns:turn.cloudflare.com:443?transport=tcp",
            ],
            "username": "cf-user",
            "credential": "cf-cred",
        },
    ]
}
CF_CLEAN = [
    {"urls": ["stun:stun.cloudflare.com:3478"]},
    {
        "urls": [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turn:turn.cloudflare.com:3478?transport=tcp",
            "turns:turn.cloudflare.com:5349?transport=tcp",
            "turn:turn.cloudflare.com:80?transport=tcp",
            "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        "username": "cf-user",
        "credential": "cf-cred",
    },
]


class FakeCloudflare:
    def __init__(self, answer=None, status=201, error: Exception | None = None):
        self.answer = CF_ANSWER if answer is None else answer
        self.status = status
        self.error = error
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        if isinstance(self.answer, bytes):
            return httpx.Response(self.status, content=self.answer)
        return httpx.Response(self.status, json=self.answer)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


def ice(trio, user):
    response = trio.client.get("/api/ice", headers=user["auth"])
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    return response.json()["iceServers"]


def test_cloudflare_ok(make_trio):
    fake = FakeCloudflare()
    trio = make_trio(http_transport=fake.transport, **CF)
    ali = trio.user("Ali")
    assert ice(trio, ali) == [STUN, *CF_CLEAN]
    (request,) = fake.requests
    assert request.method == "POST"
    assert str(request.url) == (
        "https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers"
    )
    assert request.headers["authorization"] == "Bearer SECRET-TOKEN-xyz"
    assert json.loads(request.content) == {"ttl": 86400}


def test_cloudflare_single_object_shape(make_trio):
    """The older /credentials/generate answers iceServers as one object."""
    answer = {
        "iceServers": {
            "urls": ["turn:turn.cloudflare.com:3478?transport=udp"],
            "username": "u",
            "credential": "c",
        }
    }
    trio = make_trio(http_transport=FakeCloudflare(answer).transport, **CF)
    assert ice(trio, trio.user("Ali"))[1] == answer["iceServers"]


def test_cloudflare_is_cached_for_an_hour(make_trio):
    fake = FakeCloudflare()
    trio = make_trio(http_transport=fake.transport, **CF)
    ali, berk = trio.user("Ali"), trio.user("Berk")
    ice(trio, ali)
    ice(trio, berk)
    trio.clock.value += 3599
    ice(trio, ali)
    assert len(fake.requests) == 1
    trio.clock.value += 2
    assert ice(trio, ali) == [STUN, *CF_CLEAN]
    assert len(fake.requests) == 2


@pytest.mark.parametrize(
    "fake",
    [
        FakeCloudflare(status=401, answer={"error": "bad token"}),
        FakeCloudflare(status=500, answer={}),
        FakeCloudflare(answer=b"not json"),
        FakeCloudflare(answer={"iceServers": []}),
        FakeCloudflare(answer={"iceServers": [{"urls": ["stun:x:3478"]}]}),  # no TURN
        FakeCloudflare(answer={"iceServers": [{"urls": 5}]}),
        FakeCloudflare(error=httpx.ConnectTimeout("timed out")),
        FakeCloudflare(error=httpx.ConnectError("refused")),
    ],
    ids=["401", "500", "not-json", "empty", "no-turn", "bad-urls", "timeout", "refused"],
)
def test_cloudflare_failure_is_stun_only_and_never_logs_the_token(make_trio, caplog, fake):
    trio = make_trio(http_transport=fake.transport, **CF)
    ali = trio.user("Ali")
    with caplog.at_level(logging.DEBUG):
        assert ice(trio, ali) == [STUN]
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("ice.cloudflare.failed" in r.getMessage() for r in warnings)
    for record in caplog.records:
        assert "SECRET-TOKEN-xyz" not in record.getMessage()
        assert "SECRET-TOKEN-xyz" not in (record.exc_text or "")


def test_a_failure_is_retried_after_a_minute(make_trio):
    fake = FakeCloudflare(status=503, answer={})
    trio = make_trio(http_transport=fake.transport, **CF)
    ali = trio.user("Ali")
    assert ice(trio, ali) == [STUN]
    assert ice(trio, ali) == [STUN]
    assert len(fake.requests) == 1
    fake.status, fake.answer = 201, CF_ANSWER
    trio.clock.value += 61
    assert ice(trio, ali) == [STUN, *CF_CLEAN]
    assert len(fake.requests) == 2


def test_cloudflare_takes_precedence_over_coturn(make_trio):
    fake = FakeCloudflare()
    trio = make_trio(
        http_transport=fake.transport, turn_host="turn.example.com", turn_secret="s", **CF
    )
    servers = ice(trio, trio.user("Ali"))
    assert servers == [STUN, *CF_CLEAN]
    assert not any("turn.example.com" in u for s in servers for u in s["urls"])


def test_coturn_when_cloudflare_is_not_configured(make_trio):
    fake = FakeCloudflare()
    trio = make_trio(
        http_transport=fake.transport,
        turn_host="turn.example.com",
        turn_secret="s",
        cf_turn_key_id="only-the-id",
    )
    servers = ice(trio, trio.user("Ali"))
    assert servers[1]["urls"][0] == "turn:turn.example.com:3478?transport=udp"
    assert fake.requests == []


def test_settings_from_env_and_repr_hide_the_token():
    settings = Settings.from_env(
        {
            "TRIO_INVITE_CODE": "x",
            "TRIO_CF_TURN_KEY_ID": " k ",
            "TRIO_CF_TURN_API_TOKEN": "SECRET-TOKEN-xyz",
            "TRIO_UPLOAD_DIR": "/data/uploads",
            "TRIO_MAX_UPLOAD_MB": "7",
        }
    )
    assert settings.cf_turn_key_id == "k"
    assert settings.cloudflare_turn
    assert settings.upload_dir == "/data/uploads"
    assert settings.max_upload_bytes == 7 * 1024 * 1024
    assert "SECRET-TOKEN-xyz" not in repr(settings)
    defaults = Settings.from_env({"TRIO_INVITE_CODE": "x"})
    assert defaults.upload_dir == "./uploads" and defaults.max_upload_mb == 25
    assert not defaults.cloudflare_turn


# -- camera -------------------------------------------------------------------

VOICE = 2


def expect(sock, frame_type):
    frame = sock.receive_json()
    assert frame["type"] == frame_type, frame
    return frame


def test_camera_round_trip(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json({"type": "voice.join", "channel_id": VOICE, "camera": True})
        expect(a, "voice.peers")
        joined = expect(a, "voice.joined")
        assert joined["camera"] is True
        assert expect(b, "voice.joined")["camera"] is True

        a.send_json(
            {
                "type": "voice.state",
                "muted": False,
                "deafened": False,
                "screensharing": True,
                "camera": False,
            }
        )
        for sock in (a, b):
            state = expect(sock, "voice.state")
            assert state["camera"] is False and state["screensharing"] is True

        a.send_json(
            {
                "type": "voice.state",
                "muted": True,
                "deafened": False,
                "screensharing": False,
                "camera": True,
            }
        )
        assert expect(a, "voice.state")["camera"] is True
        expect(b, "voice.state")
        with trio.ws(berk) as b2:
            assert b2.ready["voice"][str(VOICE)] == [
                {
                    "user_id": ali["id"],
                    "muted": True,
                    "deafened": False,
                    "screensharing": False,
                    "camera": True,
                    "afk": False,
                    "reconnecting": False,
                }
            ]
        # A v1 client's voice.state (no camera) means camera off.
        a.send_json(
            {"type": "voice.state", "muted": True, "deafened": False, "screensharing": False}
        )
        assert expect(a, "voice.state")["camera"] is False


def test_camera_must_be_a_boolean(trio):
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        a.send_json({"type": "voice.join", "channel_id": VOICE, "camera": "yes"})
        frame = expect(a, "error")
        assert frame["code"] == "BAD_REQUEST"
        a.send_json({"type": "voice.join", "channel_id": VOICE})
        expect(a, "voice.peers")
        assert expect(a, "voice.joined")["camera"] is False
        a.send_json(
            {
                "type": "voice.state",
                "muted": False,
                "deafened": False,
                "screensharing": False,
                "camera": 1,
            }
        )
        assert expect(a, "error")["code"] == "BAD_REQUEST"
