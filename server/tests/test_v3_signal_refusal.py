"""CONTRACT-V3 §6: a refused signal names the peer it was for (`to`)."""

from __future__ import annotations

import json

from .conftest import quiet

VOICE = 2


def join(sock, *others) -> None:
    sock.send_json({"type": "voice.join", "channel_id": VOICE})
    while sock.receive_json()["type"] != "voice.joined":
        pass
    for other in others:
        assert other.receive_json()["type"] == "voice.joined"


def test_an_oversized_signal_frame_is_refused_with_its_target(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        assert a.receive_json()["type"] == "presence"
        join(a, b)
        join(b, a)
        # Bigger than a whole frame may be (66 560 bytes), smaller than uvicorn's cap.
        a.send_text(
            json.dumps(
                {"type": "signal", "to": berk["id"], "data": {"description": {"sdp": "x" * 70_000}}}
            )
        )
        refused = a.receive_json()
        assert refused["type"] == "error"
        assert refused["code"] == "TOO_LARGE"
        assert refused["to"] == berk["id"]
        quiet(b)  # nothing relayed


def test_an_oversized_frame_that_is_not_a_signal_has_no_target(trio):
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        for text in (
            "x" * 70_000,
            json.dumps({"type": "message.send", "content": "x" * 70_000}),
            json.dumps({"type": "signal", "to": "nope", "data": "x" * 70_000}),
        ):
            a.send_text(text)
            refused = a.receive_json()
            assert set(refused) == {"type", "code", "message"}
            assert refused["code"] == "TOO_LARGE"
