#!/bin/bash
# Entrypoint wrapper for the PostgreSQL replica.
#
# On first boot (empty data directory) it runs `pg_basebackup` against the
# primary to clone the entire cluster state, then hands off to the standard
# postgres entrypoint so the server starts as a hot standby. The
# `--write-recovery-conf` flag causes pg_basebackup to write
# `postgresql.auto.conf` (with the primary_conninfo string) and create a
# `standby.signal` file in PGDATA, both of which together make PostgreSQL
# start in standby mode.
#
# On subsequent boots the data directory already contains a valid standby
# cluster, so we skip directly to launching postgres — it will reconnect
# to the primary and continue replaying WAL from wherever it left off.

set -e

: "${PGDATA:?PGDATA must be set}"
: "${REPLICATION_USER:?REPLICATION_USER must be set}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD must be set}"
PRIMARY_HOST="${PRIMARY_HOST:-postgres-primary}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"

if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  echo "[replica] empty data dir — cloning from ${PRIMARY_HOST}:${PRIMARY_PORT}"
  # Clear any leftovers (e.g. a `lost+found` from some volume drivers).
  rm -rf "${PGDATA:?}"/*
  rm -rf "${PGDATA:?}"/.[!.]* 2>/dev/null || true

  until PGPASSWORD="${REPLICATION_PASSWORD}" pg_basebackup \
        --host="${PRIMARY_HOST}" \
        --port="${PRIMARY_PORT}" \
        --username="${REPLICATION_USER}" \
        --pgdata="${PGDATA}" \
        --format=plain \
        --wal-method=stream \
        --write-recovery-conf \
        --checkpoint=fast \
        --progress; do
    echo "[replica] primary not ready or auth not yet provisioned, retrying in 3s..."
    sleep 3
  done
  echo "[replica] base backup complete"

  chown -R postgres:postgres "${PGDATA}"
  chmod 0700 "${PGDATA}"
fi

# Hand off to the standard postgres entrypoint. `hot_standby=on` is the
# default for PG16, but we set it explicitly so the demo intent is obvious.
exec docker-entrypoint.sh postgres -c hot_standby=on
