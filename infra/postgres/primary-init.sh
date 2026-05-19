#!/bin/bash
# Initialisation script for the PostgreSQL primary.
#
# Runs once, the first time the primary's data directory is created (the
# official postgres image executes every file in /docker-entrypoint-initdb.d
# during initdb). The script:
#   1. Creates a dedicated replication role used by the replica's
#      pg_basebackup + streaming connection.
#   2. Appends a pg_hba.conf rule that lets the replication role connect
#      from anywhere on the compose network (the IP range is not
#      predictable across `docker compose up` runs, so 0.0.0.0/0 is the
#      pragmatic choice — the compose network itself is the security
#      boundary, the port is not exposed to the host).
#
# If the primary's volume already contains data from a previous Phase 4
# run, this script will NOT run. In that case bring the stack down with
# `docker compose down -v` so the volume is recreated, or create the role
# manually with psql.

set -e

: "${REPLICATION_USER:?REPLICATION_USER must be set}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD must be set}"

echo "[primary-init] creating replication role '${REPLICATION_USER}'"
psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<-EOSQL
  CREATE ROLE ${REPLICATION_USER}
    WITH REPLICATION LOGIN ENCRYPTED PASSWORD '${REPLICATION_PASSWORD}';
EOSQL

echo "[primary-init] adding pg_hba.conf rule for replication"
cat >> "${PGDATA}/pg_hba.conf" <<-EOF

# Phase 5: allow the streaming replica to connect.
host replication ${REPLICATION_USER} 0.0.0.0/0 scram-sha-256
EOF

echo "[primary-init] done"
