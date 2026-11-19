"""CONTRACT-V4 A2: the server says which version it is."""

from __future__ import annotations

import tomllib
from importlib import metadata
from pathlib import Path

from trio_server import version
from trio_server.version import VERSION, server_version

SERVER = Path(__file__).resolve().parent.parent


def test_the_version_is_the_one_in_pyproject():
    declared = tomllib.loads((SERVER / "pyproject.toml").read_text())["project"]["version"]
    assert VERSION == declared


def test_health_and_ready_carry_it(trio):
    assert trio.client.get("/api/health").json() == {"ok": True, "version": VERSION}
    with trio.ws(trio.user("Ali")) as sock:
        assert sock.ready["server_version"] == VERSION


def test_not_installed_it_falls_back_to_pyproject_then_unknown(monkeypatch, tmp_path):
    def missing(name: str) -> str:
        raise metadata.PackageNotFoundError(name)

    monkeypatch.setattr(version.metadata, "version", missing)
    good = tmp_path / "pyproject.toml"
    good.write_text('[project]\nname = "trio-server"\nversion = "9.8.7"\n')
    assert server_version(good) == "9.8.7"
    broken = tmp_path / "broken.toml"
    broken.write_text("[project\nversion = ")
    assert server_version(broken) == "unknown"
    assert server_version(tmp_path / "absent.toml") == "unknown"
    no_version = tmp_path / "nover.toml"
    no_version.write_text('[project]\nname = "x"\n')
    assert server_version(no_version) == "unknown"
