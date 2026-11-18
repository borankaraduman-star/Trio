# syntax=docker/dockerfile:1
# Trio: the web client and the server in ONE image (CONTRACT-V2 §1).
#   docker build -t trio .
# Railway finds this file at the repository root by itself. deploy/docker-compose.yml
# builds the same file for the VPS alternative.

# ---- Stage 1: build the web client -----------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
# `npm ci` needs a lockfile; fall back to `npm install` if none was committed.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY web/ ./
RUN npm run build

# ---- Stage 2: the server, serving API + websocket + built client -----------
FROM python:3.12-slim AS app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY server/pyproject.toml /app/server/pyproject.toml
COPY server/trio_server/ /app/server/trio_server/
RUN pip install /app/server

COPY --from=web /web/dist /app/static

# Runs as ROOT, on purpose. Railway mounts a volume owned by root, and its
# docs say an image with a non-root user needs RAILWAY_RUN_UID=0 to write to
# it; running as root here means there is no variable to forget. The server
# holds no privilege beyond its own data, and the container is its sandbox.
# (No VOLUME line either: Railway does not use the Dockerfile's VOLUME; the
# volume is attached in its dashboard, and compose names its own.)
RUN mkdir -p /data/uploads

ENV TRIO_STATIC_DIR=/app/static \
    TRIO_DB_PATH=/data/trio.db \
    TRIO_UPLOAD_DIR=/data/uploads \
    PORT=8000

EXPOSE 8000

# Railway ignores HEALTHCHECK (it uses the dashboard's health check path,
# /api/health); docker compose uses this one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT', '8000'), timeout=4).status == 200 else 1)"]

# ONE worker, on purpose: presence, voice rooms and the websocket registry live
# in process memory; a second worker would be a second, disjoint copy.
# $PORT: Railway sets it; the default above is 8000.
# --proxy-headers / --forwarded-allow-ips=*: the container is only reached
# through a proxy (Railway's edge, or Caddy on the VPS).
CMD ["sh", "-c", "exec uvicorn trio_server.main:app --host 0.0.0.0 --port \"${PORT:-8000}\" --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
