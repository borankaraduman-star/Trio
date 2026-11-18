"""The image's build: pinned, hash-checked dependencies and the CMD (CONTRACT-V3 §9)."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent


# -- the dependency lock ---------------------------------------------------------------------


def _name(requirement: str) -> str:
    match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", requirement)
    assert match, requirement
    return re.sub(r"[-_.]+", "-", match.group(1)).lower()


def test_every_runtime_dependency_is_pinned_with_hashes_in_the_lock():
    project = tomllib.loads((SERVER / "pyproject.toml").read_text())
    wanted = {_name(r) for r in project["project"]["dependencies"]}
    wanted |= {_name(r) for r in project["build-system"]["requires"]}
    lock = (SERVER / "requirements.lock").read_text()
    pinned = {
        re.sub(r"[-_.]+", "-", m.group(1)).lower(): m.group(2)
        for m in re.finditer(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)", lock, re.M)
    }
    missing = wanted - set(pinned)
    assert not missing, f"add to requirements.lock (see its header): {sorted(missing)}"
    # Every pin carries at least one hash.
    blocks = re.split(r"\n(?=[A-Za-z0-9])", lock.split("\n", 1)[1])
    for block in blocks:
        if re.match(r"[A-Za-z0-9][^=\s]*==", block):
            assert "--hash=sha256:" in block, block.splitlines()[0]


def test_the_dockerfile_installs_from_the_lock():
    dockerfile = (SERVER.parent / "Dockerfile").read_text()
    assert "--require-hashes -r /app/server/requirements.lock" in dockerfile
    assert "--no-deps" in dockerfile
    assert "forwarded-allow-ips" not in dockerfile
    assert "python -m trio_server" in dockerfile or '"trio_server"' in dockerfile
