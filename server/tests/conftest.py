from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from starlette.testclient import TestClient

from trio_server import Settings, create_app

INVITE = "correct-horse"


class Clock:
    def __init__(self) -> None:
        self.value = 1_800_000_000.0

    def __call__(self) -> float:
        return self.value


class Trio:
    """A running app plus the few helpers every test wants."""

    def __init__(self, client: TestClient, clock: Clock) -> None:
        self.client = client
        self.clock = clock
        self._address = 0

    def join(self, name: str, code: str = INVITE, **kwargs: Any):
        # A fresh client address per call, so only the rate-limit test meets the limit.
        if "headers" not in kwargs:
            self._address += 1
            kwargs["headers"] = {"X-Forwarded-For": f"198.51.100.{self._address}"}
        return self.client.post("/api/join", json={"invite_code": code, "name": name}, **kwargs)

    def user(self, name: str) -> dict[str, Any]:
        response = self.join(name)
        assert response.status_code == 201, response.text
        body = response.json()
        return {
            "id": body["user"]["id"],
            "name": body["user"]["name"],
            "token": body["token"],
            "auth": {"Authorization": f"Bearer {body['token']}"},
        }

    @contextmanager
    def ws(self, user: dict[str, Any]) -> Iterator[Any]:
        """A connected socket with its ``ready`` frame already read (as ``sock.ready``)."""
        with self.client.websocket_connect(f"/ws?token={user['token']}") as sock:
            sock.ready = sock.receive_json()
            assert sock.ready["type"] == "ready"
            yield sock

    def channel_id(self, kind: str) -> int:
        return next(
            c["id"] for c in self.client.app.state.hub.channels.values() if c["kind"] == kind
        )


def quiet(sock: Any) -> None:
    """Assert nothing is waiting on the socket: the next frame is our own pong."""
    sock.send_json({"type": "ping"})
    assert sock.receive_json() == {"type": "pong"}


@pytest.fixture
def make_trio(tmp_path) -> Iterator[Callable[..., Trio]]:
    opened: list[TestClient] = []

    def factory(*, http_transport: Any = None, **overrides: Any) -> Trio:
        clock = Clock()
        values: dict[str, Any] = {
            "invite_code": INVITE,
            "db_path": str(tmp_path / f"trio-{len(opened)}.db"),
            "upload_dir": str(tmp_path / f"uploads-{len(opened)}"),
        }
        values.update(overrides)
        app = create_app(Settings(**values), now=clock, http_transport=http_transport)
        client = TestClient(app)
        client.__enter__()
        opened.append(client)
        return Trio(client, clock)

    yield factory
    for client in opened:
        client.__exit__(None, None, None)


@pytest.fixture
def trio(make_trio) -> Trio:
    return make_trio()
