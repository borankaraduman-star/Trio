"""Keep the websocket token and backup tickets out of the logs.

The token travels in the query string of /ws (a browser cannot set a header
on a WebSocket), and uvicorn prints the request line of every connection.
"""

from __future__ import annotations

import logging
import re

# token= : /ws?token=…; ticket= : /api/owner/backup?ticket=… (CONTRACT-V6-OPS §3).
_TOKEN = re.compile(r"((?:token|ticket)=)[^&\s\"']+", re.IGNORECASE)


def _redact(value: object) -> object:
    if isinstance(value, str):
        return _TOKEN.sub(r"\1[redacted]", value)
    return value


class TokenRedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _redact(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(_redact(arg) for arg in record.args)
        elif isinstance(record.args, dict):
            record.args = {key: _redact(arg) for key, arg in record.args.items()}
        return True


def install() -> None:
    """Idempotent. Filters on a logger apply to the records emitted through it."""
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "trio", "trio.ws"):
        log = logging.getLogger(name)
        if not any(isinstance(f, TokenRedactingFilter) for f in log.filters):
            log.addFilter(TokenRedactingFilter())
