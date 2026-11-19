"""CONTRACT-V6-OPS §7: is the data directory on persistent storage; data age, boot count."""

from __future__ import annotations

import os
from types import SimpleNamespace

from starlette.testclient import TestClient

from trio_server import Settings, create_app
from trio_server.persistence import detect_persistent, mount_points

from .conftest import INVITE

RAILWAY = {"RAILWAY_ENVIRONMENT": "production"}


def fake_stat(devices: dict[str, int]):
    def stat(path: str):
        for prefix in sorted(devices, key=len, reverse=True):
            if path == prefix or path.startswith(prefix.rstrip("/") + "/") or prefix == "/":
                return SimpleNamespace(st_dev=devices[prefix])
        raise FileNotFoundError(path)

    return stat


SAME_DEVICE = fake_stat({"/": 1})
NO_MOUNTS = lambda: "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n"  # noqa: E731


def detect(env, *, stat=SAME_DEVICE, mountinfo=NO_MOUNTS, data_dir="/data"):
    return detect_persistent(data_dir, env, stat=stat, mountinfo=mountinfo)


def test_railway_without_a_volume_is_not_persistent():
    assert detect(RAILWAY) is False
    assert detect({"RAILWAY_ENVIRONMENT_NAME": "production"}) is False


def test_outside_railway_unknown_is_none():
    assert detect({}) is None


def test_a_railway_volume_covering_the_data_dir():
    env = {**RAILWAY, "RAILWAY_VOLUME_MOUNT_PATH": "/data", "RAILWAY_VOLUME_NAME": "trio"}
    assert detect(env) is True
    assert detect(env, data_dir="/data/sub") is True
    # A volume somewhere else does not hold the data.
    assert detect({**RAILWAY, "RAILWAY_VOLUME_MOUNT_PATH": "/other"}) is False
    assert detect({**RAILWAY, "RAILWAY_VOLUME_MOUNT_PATH": "/dat"}) is False


def test_another_device_than_root():
    assert detect(RAILWAY, stat=fake_stat({"/": 1, "/data": 2})) is True
    # A directory that does not exist yet: its nearest parent decides.
    assert detect(RAILWAY, stat=fake_stat({"/": 1, "/data": 2}), data_dir="/data/new/x") is True


def test_a_mountinfo_line_for_it():
    text = (
        "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n40 22 0:50 / /data rw,relatime - ext4 /dev/vdb rw\n"
    )
    assert detect(RAILWAY, mountinfo=lambda: text) is True
    assert mount_points("1 2 3:4 / /with\\040space rw - x y z") == ["/with space"]
    assert detect(RAILWAY, mountinfo=lambda: None) is False


def test_the_test_override_wins():
    env = {**RAILWAY, "RAILWAY_VOLUME_MOUNT_PATH": "/data"}
    assert detect({**env, "TRIO_PERSISTENT_OVERRIDE": "false"}) is False
    assert detect({"TRIO_PERSISTENT_OVERRIDE": "true"}) is True
    assert detect({**RAILWAY, "TRIO_PERSISTENT_OVERRIDE": "unknown"}) is None
    assert detect({**RAILWAY, "TRIO_PERSISTENT_OVERRIDE": "nonsense"}) is False


def test_a_failing_stat_is_not_a_failed_start():
    def broken(path):
        raise PermissionError(path)

    assert detect(RAILWAY, stat=broken) is False


def boot(tmp_path, monkeypatch, override: str | None):
    if override is None:
        monkeypatch.delenv("TRIO_PERSISTENT_OVERRIDE", raising=False)
    else:
        monkeypatch.setenv("TRIO_PERSISTENT_OVERRIDE", override)
    app = create_app(
        Settings(
            invite_code=INVITE,
            db_path=str(tmp_path / "trio.db"),
            upload_dir=str(tmp_path / "uploads"),
        ),
        now=lambda: 1_800_000_000.0,
    )
    return TestClient(app)


def test_health_ready_and_overview_carry_it(tmp_path, monkeypatch):
    with boot(tmp_path, monkeypatch, "false") as client:
        health = client.get("/api/health").json()
        assert health["persistent"] is False
        assert health["data_since"] == "2027-01-15T08:00:00.000Z"
        joined = client.post("/api/join", json={"invite_code": INVITE, "name": "Ali"}).json()
        with client.websocket_connect(f"/ws?token={joined['token']}") as sock:
            assert sock.receive_json()["persistent"] is False
        auth = {"Authorization": f"Bearer {joined['token']}"}
        server = client.get("/api/owner/overview", headers=auth).json()["server"]
        assert server["persistent"] is False and server["boot_count"] == 1
    # Restarted on the same data: the first-open time stays, the counter goes up.
    with boot(tmp_path, monkeypatch, "true") as client:
        health = client.get("/api/health").json()
        assert health == {**health, "persistent": True, "data_since": "2027-01-15T08:00:00.000Z"}
        token = client.post("/api/join", json={"invite_code": INVITE, "name": "Berk"}).json()
        assert token  # the server started
    with boot(tmp_path, monkeypatch, None) as client:
        db = client.app.state.boot
        assert db["boot_count"] == 3


def test_a_failing_detector_never_stops_the_start(tmp_path, monkeypatch):
    os.makedirs(tmp_path / "uploads")
    monkeypatch.setattr("trio_server.owner.persistence.detect_persistent", _boom)
    with boot(tmp_path, monkeypatch, None) as client:
        assert client.get("/api/health").json()["persistent"] is None


def _boom(*args, **kwargs):
    raise RuntimeError("no /proc here")
