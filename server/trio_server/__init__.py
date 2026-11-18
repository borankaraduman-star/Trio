"""Trio server: text channels, presence and WebRTC signalling for a few friends."""

from trio_server.app import create_app
from trio_server.config import Settings

__all__ = ["Settings", "create_app"]
