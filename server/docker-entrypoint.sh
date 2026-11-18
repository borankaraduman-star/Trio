#!/bin/sh
# Container entrypoint: own the data volume, then run the server as `trio`.
#
# Railway mounts its volume owned by root, and a VPS's named volume may be
# owned by whoever wrote it first. Started as root (the default), this script
# makes the data directories belong to the unprivileged `trio` user and then
# drops to it with setpriv, so the server cannot write to its own code or the
# web client under /app. It works whether or not the volume is root-owned.
# Started as any other user (docker run --user, RAILWAY_RUN_UID), it changes
# nothing and runs the command as that user.
set -eu

if [ "$(id -u)" != "0" ]; then
    exec "$@"
fi

db_dir=$(dirname "${TRIO_DB_PATH:-/data/trio.db}")
upload_dir=${TRIO_UPLOAD_DIR:-/data/uploads}

for dir in "$db_dir" "$upload_dir"; do
    mkdir -p "$dir"
    # Only what is not trio's yet: a no-op on every boot after the first.
    find "$dir" -xdev ! -user trio -exec chown trio:trio {} + 2>/dev/null || true
done

as_trio() {
    setpriv --reuid=trio --regid=trio --init-groups --no-new-privs "$@"
}

for dir in "$db_dir" "$upload_dir"; do
    if ! as_trio test -w "$dir"; then
        # A volume root may not chown (e.g. a root-squashed network share).
        # Better a running server as root than none; say so in the log.
        echo "trio-entrypoint: $dir is not writable by user trio; running as root" >&2
        exec "$@"
    fi
done

exec setpriv --reuid=trio --regid=trio --init-groups --no-new-privs \
    --inh-caps=-all --bounding-set=-all -- "$@"
