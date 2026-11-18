"""CONTRACT-V3 §6-§7 and the build: shell headers, websocket limits, validation, the lock."""

from __future__ import annotations

import json
import socket
import threading
import time

import httpx
import pytest
from starlette.websockets import WebSocketDisconnect

from trio_server import Settings, create_app
from trio_server.__main__ import uvicorn_options
from trio_server.hub import MAX_CONNECTIONS_PER_USER
from trio_server.ws import FRAME_MAX_BYTES, WS_MAX_SIZE

from .conftest import INVITE, quiet
from .test_ws import expect, expect_error, join_voice

# -- the app shell's headers -------------------------------------------------------------


@pytest.fixture
def shell(make_trio, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Trio</title>")
    (dist / "assets" / "app.js").write_text("1")
    return make_trio(static_dir=str(dist))


@pytest.mark.parametrize("path", ["/", "/index.html", "/channels/3", "/some/route"])
def test_the_shell_carries_csp_and_friends(shell, path):
    response = shell.client.get(path, headers={"Host": "trio.up.railway.app"})
    assert response.status_code == 200
    assert "<title>Trio</title>" in response.text
    csp = response.headers["content-security-policy"]
    directives = dict(d.strip().split(" ", 1) for d in csp.split(";"))
    assert directives == {
        "default-src": "'self'",
        "script-src": "'self' 'wasm-unsafe-eval' blob:",
        "worker-src": "'self' blob:",
        "connect-src": "'self' ws://trio.up.railway.app wss://trio.up.railway.app",
        "img-src": "'self' blob: data:",
        "media-src": "'self' blob:",
        "style-src": "'self' 'unsafe-inline'",
        "object-src": "'none'",
        "base-uri": "'none'",
        "frame-ancestors": "'none'",
    }
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["permissions-policy"] == (
        "camera=(self), microphone=(self), display-capture=(self)"
    )
    assert response.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize(
    ("host", "connect"),
    [
        ("localhost:8000", "'self' ws://localhost:8000 wss://localhost:8000"),
        ("[::1]:8000", "'self' ws://[::1]:8000 wss://[::1]:8000"),
        ("evil.com; script-src *", "'self'"),
        ("a b", "'self'"),
        ("", "'self'"),
    ],
)
def test_connect_src_names_only_a_plain_host(shell, host, connect):
    response = shell.client.get("/", headers={"Host": host})
    csp = response.headers["content-security-policy"]
    assert f"connect-src {connect};" in csp
    assert csp.count("script-src") == 1


def test_assets_keep_their_own_headers(shell):
    response = shell.client.get("/assets/app.js")
    assert "content-security-policy" not in response.headers
    assert "immutable" in response.headers["cache-control"]


# -- websocket connections per user ------------------------------------------------------


def test_connections_per_user_are_capped_and_the_new_one_is_refused(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    from contextlib import ExitStack

    with ExitStack() as stack:
        socks = [stack.enter_context(trio.ws(ali)) for _ in range(MAX_CONNECTIONS_PER_USER)]
        with trio.client.websocket_connect(f"/ws?token={ali['token']}") as extra:
            with pytest.raises(WebSocketDisconnect) as closed:
                extra.receive_json()
        assert closed.value.code == 4429
        # The ones already open are untouched, and others are not affected.
        quiet(socks[0])
        quiet(socks[-1])
        with trio.ws(berk) as b:
            quiet(b)
    assert trio.client.app.state.hub.conns == {}
    # Back under the cap, a new one is fine.
    with trio.ws(ali) as sock:
        quiet(sock)


# -- integers SQLite cannot hold -----------------------------------------------------


@pytest.mark.parametrize(
    "query",
    ["before=99999999999999999999", "before=9223372036854775808", "before=" + "9" * 5000],
)
def test_a_before_past_64_bits_is_422_not_500(trio, query):
    user = trio.user("Ali")
    response = trio.client.get(f"/api/channels/1/messages?{query}", headers=user["auth"])
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_the_largest_64_bit_before_is_fine(trio):
    user = trio.user("Ali")
    response = trio.client.get(
        "/api/channels/1/messages?before=9223372036854775807", headers=user["auth"]
    )
    assert response.status_code == 200


def test_huge_channel_ids_in_paths_are_404(trio):
    user = trio.user("Ali")
    for channel_id in ("99999999999999999999", "-99999999999999999999"):
        response = trio.client.get(f"/api/channels/{channel_id}/messages", headers=user["auth"])
        assert response.status_code == 404


@pytest.mark.parametrize(
    "frame",
    [
        '{"type": "message.send", "channel_id": 99999999999999999999, "content": "x"}',
        '{"type": "typing", "channel_id": 99999999999999999999}',
        '{"type": "voice.join", "channel_id": -99999999999999999999}',
    ],
)
def test_huge_ids_in_frames_are_refused_cleanly(trio, frame):
    with trio.ws(trio.user("Ali")) as sock:
        sock.send_text(frame)
        assert expect(sock, "error")["code"] == "INVALID_CHANNEL"
        quiet(sock)


def test_a_huge_signal_target_is_bad_request(trio):
    with trio.ws(trio.user("Ali")) as sock:
        sock.send_text('{"type": "signal", "to": 99999999999999999999, "data": {}}')
        expect_error(sock, "BAD_REQUEST")
        sock.send_text('{"type": "ping", "x": ' + "9" * 5000 + "}")
        expect_error(sock, "BAD_REQUEST")
        quiet(sock)


# -- lone surrogates -------------------------------------------------------------------


@pytest.mark.parametrize(
    "frame",
    [
        '{"type": "message.send", "channel_id": 1, "content": "a\\ud800b"}',
        '{"type": "message.send", "channel_id": 1, "content": "ok", "nonce": "\\udfff"}',
        '{"type": "message.send", "channel_id": 1, "content": "", "attachment_ids": ["\\ud800"]}',
        '{"type": "typing", "channel_id": 1, "x": "\\ud800"}',
        '{"type": "\\ud800"}',
    ],
)
def test_lone_surrogates_in_frames_are_bad_request(trio, frame):
    user = trio.user("Ali")
    with trio.ws(user) as sock:
        sock.send_text(frame)
        expect_error(sock, "BAD_REQUEST")
        quiet(sock)
    listed = trio.client.get("/api/channels/1/messages", headers=user["auth"]).json()
    assert listed["messages"] == []


def test_a_lone_surrogate_in_signal_data_is_bad_request_and_not_relayed(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        join_voice((a, b), a)
        join_voice((a, b), b)
        a.send_text(json.dumps({"type": "signal", "to": berk["id"]})[:-1] + ', "data": "\\ud800"}')
        expect_error(a, "BAD_REQUEST")
        quiet(b)  # nothing was relayed
        # Valid astral text (a real surrogate PAIR in JSON) is fine.
        a.send_text(
            json.dumps({"type": "signal", "to": berk["id"]})[:-1] + ', "data": "\\ud83d\\ude00"}'
        )
        assert expect(b, "signal")["data"] == "😀"


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/join", '{"invite_code": "\\ud800", "name": "Ali"}'),
        ("/api/join", '{"invite_code": "correct-horse", "name": "\\ud800"}'),
        ("/api/join", '{"link_code": "\\ud800"}'),
    ],
)
def test_lone_surrogates_in_rest_bodies_are_422(trio, path, body):
    response = trio.client.post(
        path,
        content=body.encode(),
        headers={"Content-Type": "application/json", "X-Forwarded-For": "198.51.100.77"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_a_lone_surrogate_in_a_channel_name_is_422(trio):
    user = trio.user("Ali")
    response = trio.client.post(
        "/api/channels",
        content=b'{"name": "\\ud800", "kind": "text"}',
        headers={**user["auth"], "Content-Type": "application/json"},
    )
    assert response.status_code == 422


def test_odd_bytes_in_an_upload_filename_never_500(trio):
    user = trio.user("Ali")
    boundary = "b"
    # Invalid UTF-8 and an encoded lone surrogate (ED A0 80) in the name.
    body = (
        b'--b\r\nContent-Disposition: form-data; name="file"; filename="a\xff\xfe\xed\xa0\x80.txt"'
        b"\r\n\r\nhello\r\n--b--\r\n"
    )
    response = trio.client.post(
        "/api/uploads",
        content=body,
        headers={**user["auth"], "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    assert response.status_code == 201
    response.json()["attachment"]["filename"].encode("utf-8")


# -- uvicorn options and a real server --------------------------------------------------------


def test_uvicorn_options():
    options = uvicorn_options("0.0.0.0", 8000)  # noqa: S104 - the container's interface
    assert options["workers"] == 1
    assert options["proxy_headers"] is False
    assert FRAME_MAX_BYTES < options["ws_max_size"] == WS_MAX_SIZE < 256 * 1024


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def live_server(tmp_path):
    """The real uvicorn on loopback, with the options the image uses."""
    import uvicorn

    port = _free_port()
    settings = Settings(
        invite_code=INVITE, db_path=str(tmp_path / "live.db"), upload_dir=str(tmp_path / "up")
    )
    options = uvicorn_options("127.0.0.1", port)
    options.pop("workers")
    server = uvicorn.Server(uvicorn.Config(create_app(settings), log_level="warning", **options))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        assert time.monotonic() < deadline, "uvicorn did not start"
        time.sleep(0.02)
    yield f"127.0.0.1:{port}"
    server.should_exit = True
    thread.join(10)


def test_a_real_server_refuses_a_15_mb_frame_without_buffering_it(live_server):
    from websockets.exceptions import ConnectionClosed
    from websockets.sync.client import connect

    joined = httpx.post(
        f"http://{live_server}/api/join", json={"invite_code": INVITE, "name": "Ali"}
    ).json()
    with connect(f"ws://{live_server}/ws?token={joined['token']}", max_size=None) as ws:
        assert json.loads(ws.recv(timeout=5))["type"] == "ready"
        # Just over the app's cap: the friendly error frame, socket stays open.
        ws.send("x" * (FRAME_MAX_BYTES + 10))
        assert json.loads(ws.recv(timeout=5))["code"] == "TOO_LARGE"
        ws.send(json.dumps({"type": "ping"}))
        assert json.loads(ws.recv(timeout=5)) == {"type": "pong"}
        # 15 MB: uvicorn closes with 1009 (message too big).
        with pytest.raises(ConnectionClosed) as closed:
            ws.send("x" * (15 * 1024 * 1024))
            ws.recv(timeout=5)
        assert closed.value.rcvd is not None and closed.value.rcvd.code == 1009
