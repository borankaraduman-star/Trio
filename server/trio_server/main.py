"""ASGI entry point: ``uvicorn trio_server.main:app``.

Importing this module reads the environment, so a missing TRIO_INVITE_CODE
stops uvicorn before it listens.
"""

from trio_server.app import create_app
from trio_server.config import Settings

app = create_app(Settings.from_env())
