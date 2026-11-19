"""Is the data directory on persistent storage? (CONTRACT-V6-OPS §7)

On Railway a service without a volume writes to the container's own disk,
which every deploy throws away: the next update would silently delete every
account, message and file. Nothing failed, so nothing warned. This decides,
once at startup, ``True`` (a volume or a separate mount holds the data),
``False`` (on Railway, and nothing says the data directory is mounted) or
``None`` (not on Railway and no mount seen: unknown, and nothing is shown).
It never stops the server from starting.

Signals, in order:

1. ``TRIO_PERSISTENT_OVERRIDE`` = ``true`` | ``false`` | ``unknown`` — for
   tests only (the e2e suite forces the Railway-without-volume case with it);
2. ``RAILWAY_VOLUME_MOUNT_PATH`` covering the data directory (Railway sets it,
   with ``RAILWAY_VOLUME_NAME``, on a service that has a volume);
3. the data directory (or a parent below ``/``) is on another device than ``/``;
4. a ``/proc/self/mountinfo`` mount point (other than ``/``) covering it.
"""

from __future__ import annotations

import contextlib
import logging
import os
from collections.abc import Callable, Mapping
from pathlib import PurePosixPath

logger = logging.getLogger("trio")

OVERRIDE_ENV = "TRIO_PERSISTENT_OVERRIDE"
MOUNTINFO = "/proc/self/mountinfo"


def _covers(mount: str, path: str) -> bool:
    mount_path = PurePosixPath(os.path.normpath(mount))
    target = PurePosixPath(os.path.normpath(path))
    return str(mount_path) != "/" and (target == mount_path or mount_path in target.parents)


def _unescape(field: str) -> str:
    # mountinfo escapes space, tab, newline and backslash as \ooo.
    out, i = [], 0
    while i < len(field):
        if field[i] == "\\" and field[i + 1 : i + 4].isdigit() and len(field[i + 1 : i + 4]) == 3:
            out.append(chr(int(field[i + 1 : i + 4], 8)))
            i += 4
        else:
            out.append(field[i])
            i += 1
    return "".join(out)


def mount_points(mountinfo: str) -> list[str]:
    points = []
    for line in mountinfo.splitlines():
        fields = line.split(" ")
        if len(fields) > 4:
            points.append(_unescape(fields[4]))
    return points


def _read_mountinfo() -> str | None:
    try:
        with open(MOUNTINFO, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def detect_persistent(
    data_dir: str,
    env: Mapping[str, str] | None = None,
    *,
    stat: Callable[[str], os.stat_result] = os.stat,
    mountinfo: Callable[[], str | None] = _read_mountinfo,
) -> bool | None:
    env = os.environ if env is None else env
    override = env.get(OVERRIDE_ENV, "").strip().lower()
    if override in ("true", "false", "unknown"):
        return {"true": True, "false": False, "unknown": None}[override]
    data_dir = os.path.abspath(data_dir)

    volume = env.get("RAILWAY_VOLUME_MOUNT_PATH", "").strip()
    if volume and _covers(volume, data_dir):
        return True

    with contextlib.suppress(OSError):
        root = stat("/").st_dev
        # The directory may not exist yet: its nearest existing parent decides.
        probe = data_dir
        while True:
            try:
                device = stat(probe).st_dev
                break
            except FileNotFoundError:
                parent = os.path.dirname(probe)
                if parent == probe:
                    raise
                probe = parent
        if device != root:
            return True

    text = mountinfo()
    if text and any(_covers(point, data_dir) for point in mount_points(text)):
        return True

    if (
        env.get("RAILWAY_ENVIRONMENT", "").strip()
        or env.get("RAILWAY_ENVIRONMENT_NAME", "").strip()
    ):
        return False
    return None


def log_verdict(persistent: bool | None, data_dir: str) -> None:
    if persistent is False:
        logger.error(
            "storage.not_persistent data_dir=%s: no volume is mounted here; the next deploy "
            "deletes every account, message and file. Attach a Railway volume at this path.",
            data_dir,
        )
    else:
        logger.info("storage.persistent=%s data_dir=%s", persistent, data_dir)
