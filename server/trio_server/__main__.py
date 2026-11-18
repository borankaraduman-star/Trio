"""Run the server: ``python -m trio_server [--host H] [--port P] [--reload]``.

The one place uvicorn's options are decided, so that the Docker image, the
README's local command and the tests run the same server:

- ONE worker: presence, voice and the socket registry live in memory.
- ``ws_max_size``: uvicorn's default buffers a single websocket message of
  up to 16 MiB before the app can refuse it; this caps it just above the
  app's own frame limit.
- No ``proxy_headers``: the app reads X-Forwarded-For itself, honouring
  TRIO_TRUSTED_PROXY_HOPS (see trio_server.ratelimit). Letting uvicorn
  rewrite the peer from the header (``--forwarded-allow-ips='*'``) made the
  client's own leftmost entry the "client address" in the logs and in the
  fallback. Nothing in the app builds absolute URLs from the scheme.
"""

from __future__ import annotations

import argparse
import os
from collections.abc import Sequence
from typing import Any

from trio_server.ws import WS_MAX_SIZE

APP = "trio_server.main:app"


def uvicorn_options(host: str, port: int) -> dict[str, Any]:
    return {
        "host": host,
        "port": port,
        "workers": 1,
        "ws_max_size": WS_MAX_SIZE,
        "proxy_headers": False,
        # Close sockets whose peer vanished without a close frame.
        "ws_ping_interval": 20.0,
        "ws_ping_timeout": 20.0,
    }


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m trio_server", description="Run Trio.")
    parser.add_argument("--host", default="127.0.0.1", help="default 127.0.0.1")
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("PORT", "") or 8000), help="default $PORT"
    )
    parser.add_argument("--reload", action="store_true", help="restart on code changes (dev)")
    parser.add_argument("--log-level", default="info")
    args = parser.parse_args(argv)

    import uvicorn

    options = uvicorn_options(args.host, args.port)
    if args.reload:
        options.pop("workers")
    uvicorn.run(APP, reload=args.reload, log_level=args.log_level, **options)


if __name__ == "__main__":
    main()
