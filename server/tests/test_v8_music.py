"""CONTRACT-V8-MUSIC §2: ``music`` and ``music_title`` on the voice frames."""

from __future__ import annotations

from trio_server.validation import clean_music_title

from .test_ws import VOICE, expect, expect_error

STATE = {"type": "voice.state", "muted": False, "deafened": False, "screensharing": False}


def test_an_old_client_never_sends_music_and_reads_as_not_sharing(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json({"type": "voice.join", "channel_id": VOICE})
        expect(a, "voice.peers")
        joined = expect(b, "voice.joined")
        assert joined["music"] is False and joined["music_title"] is None
        expect(a, "voice.joined")
        a.send_json({**STATE, "muted": True})
        state = expect(b, "voice.state")
        assert state["music"] is False and state["music_title"] is None
        with trio.ws(berk) as b2:
            entry = b2.ready["voice"][str(VOICE)][0]
            assert entry["music"] is False and entry["music_title"] is None


def test_music_and_title_are_relayed_on_state_ready_and_join(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json({"type": "voice.join", "channel_id": VOICE, "session": "s1"})
        expect(a, "voice.peers")
        expect(a, "voice.joined")
        expect(b, "voice.joined")

        a.send_json({**STATE, "music": True, "music_title": "  Daft Punk — One More Time "})
        state = expect(b, "voice.state")
        assert state["music"] is True
        assert state["music_title"] == "Daft Punk — One More Time"
        expect(a, "voice.state")
        with trio.ws(berk) as b2:
            entry = b2.ready["voice"][str(VOICE)][0]
            assert entry["music"] is True and entry["music_title"] == "Daft Punk — One More Time"

        # A share without a title is not an error.
        a.send_json({**STATE, "music": True, "music_title": None})
        state = expect(b, "voice.state")
        assert state["music"] is True and state["music_title"] is None
        expect(a, "voice.state")

        # A title is never kept while not sharing.
        a.send_json({**STATE, "music": False, "music_title": "secret"})
        state = expect(b, "voice.state")
        assert state["music"] is False and state["music_title"] is None
        expect(a, "voice.state")

        # A resume (CONTRACT-V4 A) carries the share.
        with trio.ws(ali) as a2:
            a2.send_json(
                {
                    "type": "voice.join",
                    "channel_id": VOICE,
                    "resume": True,
                    "session": "s1",
                    "music": True,
                    "music_title": "Kalbim",
                }
            )
            expect(a2, "voice.peers")
            joined = expect(a2, "voice.joined")
            assert joined["resumed"] is True
            assert joined["music"] is True and joined["music_title"] == "Kalbim"


def test_leaving_clears_the_share(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json({"type": "voice.join", "channel_id": VOICE, "music": True, "music_title": "x"})
        expect(a, "voice.peers")
        expect(a, "voice.joined")
        assert expect(b, "voice.joined")["music"] is True
        a.send_json({"type": "voice.leave"})
        expect(a, "voice.left")
        expect(b, "voice.left")
        a.send_json({"type": "voice.join", "channel_id": VOICE})
        expect(a, "voice.peers")
        joined = expect(b, "voice.joined")
        assert joined["music"] is False and joined["music_title"] is None


def test_wrong_types_are_refused(trio):
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        a.send_json({"type": "voice.join", "channel_id": VOICE, "music": "yes"})
        expect_error(a, "BAD_REQUEST")
        a.send_json({"type": "voice.join", "channel_id": VOICE})
        expect(a, "voice.peers")
        expect(a, "voice.joined")
        a.send_json({**STATE, "music": 1})
        expect_error(a, "BAD_REQUEST")
        a.send_json({**STATE, "music": True, "music_title": 42})
        expect_error(a, "BAD_REQUEST")
        a.send_json({**STATE, "music": True, "music_title": ["a"]})
        expect_error(a, "BAD_REQUEST")


def test_the_title_is_cleaned_and_cut():
    assert clean_music_title("   ") is None
    assert clean_music_title("") is None
    # Bidi overrides, zero-width marks, NUL and newlines go; the text stays one line.
    assert clean_music_title("a‮b​c\x00d\ne\tf") == "abcd e f"
    assert clean_music_title("‮​") is None
    long = "ş" * 200
    assert clean_music_title(long) == "ş" * 120
    assert clean_music_title("x" * 119 + " yz") == "x" * 119
    # A title that is HTML stays text; the client renders it as text.
    assert clean_music_title("<b>hi</b>") == "<b>hi</b>"
