"""CONTRACT-V6-VOICE: ``afk`` on voice.join / voice.state / ready.voice."""

from __future__ import annotations

from .test_ws import VOICE, expect, expect_error


def test_afk_is_false_by_default_and_follows_voice_state(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json({"type": "voice.join", "channel_id": VOICE})
        expect(a, "voice.peers")
        assert expect(a, "voice.joined")["afk"] is False
        assert expect(b, "voice.joined")["afk"] is False

        a.send_json(
            {
                "type": "voice.state",
                "muted": True,
                "deafened": False,
                "screensharing": False,
                "afk": True,
            }
        )
        state = expect(b, "voice.state")
        assert state["afk"] is True and state["muted"] is True
        expect(a, "voice.state")
        with trio.ws(berk) as b2:
            assert b2.ready["voice"][str(VOICE)][0]["afk"] is True

        # A state from a client that predates afk (no key) means "not afk".
        a.send_json(
            {"type": "voice.state", "muted": False, "deafened": False, "screensharing": False}
        )
        assert expect(b, "voice.state")["afk"] is False


def test_afk_on_join_and_resume_is_kept(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(berk) as b:
        with trio.ws(ali) as a:
            expect(b, "presence")
            a.send_json(
                {
                    "type": "voice.join",
                    "channel_id": VOICE,
                    "afk": True,
                    "muted": True,
                    "session": "s1",
                }
            )
            expect(a, "voice.peers")
            assert expect(a, "voice.joined")["afk"] is True
            assert expect(b, "voice.joined")["afk"] is True
            # The same call resumed (another socket, same session) keeps what the join says.
            with trio.ws(ali) as a2:
                a2.send_json(
                    {
                        "type": "voice.join",
                        "channel_id": VOICE,
                        "afk": False,
                        "resume": True,
                        "session": "s1",
                    }
                )
                expect(a2, "voice.peers")
                joined = expect(a2, "voice.joined")
                assert joined["afk"] is False and joined["resumed"] is True


def test_afk_must_be_a_boolean(trio):
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        a.send_json({"type": "voice.join", "channel_id": VOICE, "afk": "yes"})
        expect_error(a, "BAD_REQUEST")
        a.send_json({"type": "voice.join", "channel_id": VOICE})
        expect(a, "voice.peers")
        expect(a, "voice.joined")
        a.send_json(
            {
                "type": "voice.state",
                "muted": False,
                "deafened": False,
                "screensharing": False,
                "afk": 1,
            }
        )
        expect_error(a, "BAD_REQUEST")
