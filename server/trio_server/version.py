"""The server's version: one source, the package version in ``pyproject.toml``.

Installed (the image, ``uv pip install -e``), it is read from the package
metadata. Run from a source tree that was never installed, it is read from
``pyproject.toml`` next to the package; failing both it is ``"unknown"`` —
never an exception at import.
"""

from __future__ import annotations

import tomllib
from importlib import metadata
from pathlib import Path

DISTRIBUTION = "trio-server"
UNKNOWN = "unknown"


def _from_pyproject(path: Path) -> str | None:
    try:
        project = tomllib.loads(path.read_text(encoding="utf-8"))["project"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    version = project.get("version") if isinstance(project, dict) else None
    return version if isinstance(version, str) and version else None


def server_version(pyproject: Path | None = None) -> str:
    try:
        return metadata.version(DISTRIBUTION)
    except metadata.PackageNotFoundError:
        pass
    path = pyproject or Path(__file__).resolve().parent.parent / "pyproject.toml"
    return _from_pyproject(path) or UNKNOWN


VERSION = server_version()
