# PostgreSQL Replication

This document describes the replicated PostgreSQL setup added in Phase 5 of
the project. The goal is to demonstrate that encrypted message history is
durable beyond a single database node: every row written to the primary is
asynchronously copied to a hot-standby replica, and the encryption guarantee
holds on both copies.

## Why database replication

The chat application stores users and encrypted message history. With a
single PostgreSQL instance the whole conversation history is gone if that
one server is lost, even though the application tier already has three
backend nodes and tolerates the loss of any individual backend. Replication
solves the database side of the same story:

- **Durability.** A second, continuously updated copy of the data exists on
  a different server (in this demo: a different Docker container; in
  Proxmox: a different LXC guest on a different host).
- **Read scalability (latent).** Read-heavy workloads can in principle be
  routed to the replica. The current backend does not do this — every query
  goes to the primary — but the infrastructure is in place to add a
  read-only Prisma client later without re-architecting.
- **Disaster recovery story for the thesis.** "If we lose the primary, the
  encrypted history is still on the replica, and the replica can be
  promoted." This is a concrete, demonstrable failure scenario that
  complements the application-tier failover already shown for the backend
  nodes.

## How it works

```
                           writes
            ┌──────────────────────────────────┐
            ▼                                  │
   ┌──────────────────┐  WAL stream  ┌────────────────┐
   │ postgres-primary │ ───────────▶ │ postgres-replica │
   │  (RW, 1 process) │  async (sec) │  (RO, hot standby) │
   └──────────────────┘              └────────────────┘
            ▲                                  ▲
            │ all backend writes               │ read-only / ad-hoc psql
            │                                  │
    ┌──────────────┬──────────────┬──────────────┐
    │  backend-1   │  backend-2   │  backend-3   │
    └──────────────┴──────────────┴──────────────┘
```

The mechanism is PostgreSQL's built-in **streaming replication** (no
external tooling like Patroni, repmgr, or pglogical):

1. The primary writes every change to its write-ahead log (WAL). With
   `wal_level=replica` and `max_wal_senders>0` it accepts streaming
   connections from standbys.
2. The replica connects as the dedicated `replicator` role and pulls WAL
   records as they are produced. The replica re-applies those records to
   its own data directory, so its on-disk state stays in sync.
3. `hot_standby=on` lets the replica accept read-only `SELECT` queries
   while it is still streaming.

Replication is **asynchronous**: a successful `INSERT` on the primary
returns to the application before the WAL record reaches the replica. In
practice the lag inside a single compose network is a few milliseconds, but
in a failure scenario the most recent committed transactions on the primary
can be lost if the primary disk dies before the WAL is shipped. This is the
usual trade-off — synchronous replication is supported by PostgreSQL but
roughly doubles the write latency and was judged out of scope for a thesis
demo.

### Primary handles writes

All three backend nodes connect with:

```
DATABASE_URL=postgresql://chat:chat@postgres-primary:5432/chat
```

There is no application-level routing: Prisma always talks to the primary.
This is the simplest model that is correct — replicas would reject any
attempt to write anyway (`ERROR: cannot execute INSERT in a read-only
transaction`).

### Replica receives copied data

The replica is bootstrapped on first boot by
[`infra/postgres/replica-entrypoint.sh`](../infra/postgres/replica-entrypoint.sh).
When the data directory is empty the script runs:

```
pg_basebackup --host=postgres-primary --port=5432 \
              --username=replicator \
              --pgdata=$PGDATA \
              --format=plain --wal-method=stream \
              --write-recovery-conf
```

`pg_basebackup`:

- Copies the entire current state of the primary (data files + initial WAL
  segments) into the replica's data directory.
- With `--write-recovery-conf` (`-R`), writes `postgresql.auto.conf` with
  `primary_conninfo=...` and creates an empty `standby.signal` file. Those
  two together tell PostgreSQL to start as a standby on next boot.

On subsequent boots the directory is no longer empty, so the script skips
the basebackup and goes straight to `postgres -c hot_standby=on`. The
replica reconnects to the primary and continues replaying WAL from
wherever it left off.

The replication role is created by
[`infra/postgres/primary-init.sh`](../infra/postgres/primary-init.sh),
which is dropped into `/docker-entrypoint-initdb.d/` on the primary so it
runs exactly once during initdb. The script also appends a `pg_hba.conf`
rule that allows the role to connect from the compose network.

### Messages remain encrypted on both primary and replica

Replication operates **below the application layer**. PostgreSQL's WAL
contains the literal page changes that the writer produced, including the
exact bytes of every column. The two ciphertext columns
(`ciphertextForRecipient`, `ciphertextForSender`) are stored as base64
strings; the WAL ships those strings byte-for-byte to the replica.

The encryption guarantee is therefore **identical on both servers**:

- The plaintext was never present on the primary in the first place — the
  client sent only sealed-box ciphertext.
- The replica receives byte-for-byte the same row as the primary stored.
- Neither database has any private key with which to decrypt that
  ciphertext.

In other words, replication is not a privacy regression. It increases the
number of locations where ciphertext exists, but the locations where
plaintext exists is unchanged: only the two participating browsers.

### What happens if the primary fails

The current Docker setup is **demo replication, not automatic failover**.
If the primary crashes:

- The three backend nodes immediately see write errors (Prisma raises
  `P1001 / Can't reach database server`). Reads also fail, because the
  application's connection string points at the primary.
- The replica keeps running and keeps the most-recently-streamed snapshot
  of the data available for read-only queries via `psql`.
- Recovery options:
  - **Restart the primary** (`docker compose start postgres-primary`).
    For transient failures (process crash, container restart, brief disk
    glitch) this is enough — the replica reconnects and catches up.
  - **Promote the replica** with `pg_ctl promote` or
    `SELECT pg_promote();`. The replica then accepts writes; the backend
    `DATABASE_URL` has to be repointed to it (manually, or via a future
    pgbouncer / HAProxy layer).

Automated failover with a leader election would require a coordinator such
as Patroni or repmgr plus etcd/Consul, which is more infrastructure than
this thesis aims to demonstrate. The architecture is deliberately one step
short of automated failover so the manual promotion step is the central
demo, not a side effect.

### What is implemented in Docker

| Component | Concrete Docker artefact |
|---|---|
| Primary | service `postgres-primary` (image `postgres:16-alpine`) with `wal_level=replica`, `max_wal_senders=10`, `wal_keep_size=64MB`, `hot_standby=on`, `listen_addresses=*` |
| Replica | service `postgres-replica` (same image) launched via `infra/postgres/replica-entrypoint.sh`, which clones the primary on first boot |
| Replication role | `replicator` role created by `infra/postgres/primary-init.sh`, password from `REPLICATION_PASSWORD` |
| `pg_hba.conf` rule | `host replication replicator 0.0.0.0/0 scram-sha-256`, appended by the init script |
| Volumes | `postgres_primary_data`, `postgres_replica_data` (separate named volumes — no sharing) |
| Network | The default compose network; ports are not published to the host (the entry point for the application stack is still Nginx on `:8080`) |

The replica's `pg_isready` healthcheck reports `accepting connections`
once it has streamed up to a consistent recovery point and is serving
hot-standby reads, so `docker compose up -d` waits until replication is
actually online before reporting success.

### How this maps to Proxmox

[`docs/proxmox-deployment.md`](proxmox-deployment.md) describes a
six-guest LXC layout where Postgres + Redis live on a single shared data
guest (`chat-data`). Phase 5 introduces a second data guest:

| Compose service | Proxmox LXC guest | IP (suggested) | Notes |
|---|---|---|---|
| `postgres-primary` | `chat-db-primary` | `10.10.10.20/24` | Hosts the writeable cluster |
| `postgres-replica` | `chat-db-replica` | `10.10.10.21/24` | Hosts a hot standby on a different physical host |
| `redis` | stays on `chat-data` or moves to `chat-cache` | `10.10.10.22/24` | Unchanged |

In the LXC version the `postgresql.conf` and `pg_hba.conf` changes that
`infra/postgres/primary-init.sh` and `replica-entrypoint.sh` perform here
are instead written into the guest's filesystem during provisioning
(Ansible role, cloud-init, or a manual `systemctl restart postgresql`
after editing the files). `pg_basebackup` is run by hand on the replica
guest the first time:

```
sudo -u postgres pg_basebackup -h 10.10.10.20 -U replicator \
     -D /var/lib/postgresql/16/main \
     -Fp -Xs -R --checkpoint=fast --progress
```

After that the streaming relationship and the hot-standby behaviour are
exactly the same as in Docker. The thesis demo can therefore be presented
as one architecture with two deployment targets (Docker for development,
Proxmox for the final defence), where the choice of orchestrator does not
change the replication semantics.

## Verifying replication

Two clean ways to demonstrate that data really is on both servers.

### A. Write something through the app and read both databases

```bash
# 1. Send a message in the UI (alice → bob) so a new Message row is created.

# 2. Read the row from the primary.
docker compose exec postgres-primary \
  psql -U chat -d chat \
  -c 'SELECT id, "senderId", "recipientId", left("ciphertextForRecipient", 24) AS ct, "createdAt"
        FROM "Message" ORDER BY "createdAt" DESC LIMIT 3;'

# 3. Read the same row from the replica. The replica is read-only, so
#    SELECTs work but anything that mutates state will be rejected.
docker compose exec postgres-replica \
  psql -U chat -d chat \
  -c 'SELECT id, "senderId", "recipientId", left("ciphertextForRecipient", 24) AS ct, "createdAt"
        FROM "Message" ORDER BY "createdAt" DESC LIMIT 3;'
```

Both queries return the same row(s), with the same `id` and same ciphertext
prefix. There is no plaintext column on either side because the schema
itself does not have one — see
[`docs/database-model.md`](database-model.md).

### B. Confirm one server is primary and the other is in recovery

```bash
# Should return: f  (false — this is the writable primary)
docker compose exec postgres-primary \
  psql -U chat -d chat -tAc 'SELECT pg_is_in_recovery();'

# Should return: t  (true — this is a hot-standby replica)
docker compose exec postgres-replica \
  psql -U chat -d chat -tAc 'SELECT pg_is_in_recovery();'
```

You can also inspect the live streaming relationship from the primary:

```bash
docker compose exec postgres-primary \
  psql -U chat -d chat \
  -c "SELECT application_name, client_addr, state, sync_state,
             pg_wal_lsn_diff(sent_lsn, replay_lsn) AS lag_bytes
        FROM pg_stat_replication;"
```

A healthy result has one row with `state=streaming`, `sync_state=async`,
and `lag_bytes` close to 0.

### C. Show that the replica refuses writes

```bash
docker compose exec postgres-replica \
  psql -U chat -d chat \
  -c "INSERT INTO \"User\" (id, username, email, \"passwordHash\", \"publicKey\")
      VALUES ('x','x','x','x','x');"
# expected: ERROR:  cannot execute INSERT in a read-only transaction
```

This is the property that justifies keeping `DATABASE_URL` pointed at the
primary: the replica protects itself against accidental writes at the
PostgreSQL level, not at the application level.

### D. Show that ciphertext is the same byte-for-byte

A stronger version of test A: hash one specific row's ciphertext on both
servers and confirm the hashes match.

```bash
docker compose exec postgres-primary \
  psql -U chat -d chat -tAc \
  'SELECT md5("ciphertextForRecipient") FROM "Message" ORDER BY "createdAt" DESC LIMIT 1;'

docker compose exec postgres-replica \
  psql -U chat -d chat -tAc \
  'SELECT md5("ciphertextForRecipient") FROM "Message" ORDER BY "createdAt" DESC LIMIT 1;'
```

The two MD5 strings must be identical. If they are, the replica is holding
the same ciphertext bytes as the primary — and neither side has the keys to
decrypt them.

## Limitations

- **Asynchronous, not synchronous.** A small window of in-flight commits
  can be lost if the primary dies before its WAL reaches the replica.
- **No automated failover.** Promotion is a manual `pg_promote()` plus a
  manual `DATABASE_URL` change. A real production setup would use Patroni,
  repmgr, or RDS-style managed failover.
- **No connection-level read routing.** Backend reads still go to the
  primary; the replica is for durability and demo, not for read scaling.
  Splitting reads would require either a second Prisma client or pgbouncer
  in front of both servers.
- **One replica.** Streaming replication supports many standbys (cascading
  replication too), but this demo runs a single replica to keep the
  compose topology readable.
- **Replication user is reachable from `0.0.0.0/0` *inside* the compose
  network.** The compose network is private and the port is not published,
  so this is acceptable for a demo. A production deployment should
  restrict `pg_hba.conf` to the replica's actual IP/CIDR.
