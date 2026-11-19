# syntax=docker/dockerfile:1
# Trio: the web client and the server in ONE image (CONTRACT-V2 §1, CONTRACT-V3 §9).
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
# Test cases shared with the server; tsc type-checks the web tests that import them.
COPY shared/ /shared/
RUN npm run build

# ---- Stage 2: the server, serving API + websocket + built client -----------
FROM python:3.12-slim AS app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# The unprivileged user the server runs as (see server/docker-entrypoint.sh).
RUN groupadd --system --gid 10001 trio \
    && useradd --system --uid 10001 --gid trio --home-dir /nonexistent \
       --no-create-home --shell /usr/sbin/nologin trio

WORKDIR /app
# Dependencies first and from the lock: every version pinned, every file
# hash-checked (server/requirements.lock; regenerate it as its header says).
COPY server/requirements.lock /app/server/requirements.lock
RUN pip install --require-hashes -r /app/server/requirements.lock
COPY server/pyproject.toml /app/server/pyproject.toml
COPY server/trio_server/ /app/server/trio_server/
# The package itself: nothing more is resolved, and the build backend is the
# locked setuptools rather than whatever PyPI serves today.
RUN pip install --no-deps --no-build-isolation /app/server

COPY --from=web /web/dist /app/static
COPY --chmod=0755 server/docker-entrypoint.sh /usr/local/bin/trio-entrypoint

# Root owns /app (code and client): the server, running as `trio`, cannot
# change them. /data is the volume; the entrypoint makes it trio's at start,
# which is what makes a root-owned Railway volume work without
# RAILWAY_RUN_UID. (No VOLUME line: Railway does not use the Dockerfile's
# VOLUME; the volume is attached in its dashboard, and compose names its own.)
RUN mkdir -p /data/uploads && chown -R trio:trio /data

ENV TRIO_STATIC_DIR=/app/static \
    TRIO_DB_PATH=/data/trio.db \
    TRIO_UPLOAD_DIR=/data/uploads \
    PORT=8000

EXPOSE 8000

# Railway ignores HEALTHCHECK (it uses the dashboard's health check path,
# /api/health); docker compose uses this one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT', '8000'), timeout=4).status == 200 else 1)"]

ENTRYPOINT ["trio-entrypoint"]
# python -m trio_server holds every uvicorn option (trio_server/__main__.py):
# ONE worker (presence, voice and the socket registry live in memory), $PORT
# (Railway sets it; the default above is 8000), a websocket message cap just
# above the app's own frame limit, and NO proxy-header rewriting: the app
# reads X-Forwarded-For itself (TRIO_TRUSTED_PROXY_HOPS).
CMD ["python", "-m", "trio_server", "--host", "0.0.0.0"]
