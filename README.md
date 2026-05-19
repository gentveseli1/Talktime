# Distributed Real-Time E2EE Chat

University final project: a real-time chat application demonstrating distributed
systems concepts (3 backend nodes, automatic failover, Redis-coordinated pub/sub)
combined with educational end-to-end encryption (per-user libsodium keypair, the
server only ever stores ciphertext).

> **Educational E2EE.** This project implements a simple sealed-box scheme suitable
> for a thesis demonstration. It is **not** a Signal Protocol implementation and
> does not provide forward secrecy or multi-device key sync. See
> [`docs/e2ee.md`](docs/e2ee.md) for the full threat model.

## Architecture

```
                       ┌─────────────────────────┐
                       │       Browser (React)   │
                       │  libsodium keypair      │
                       │  private key in IDB     │
                       └────────────┬────────────┘
                                    │ http / ws
                                    ▼
                       ┌─────────────────────────┐
                       │   Nginx (load balancer) │
                       │   ip_hash, WS upgrade   │
                       └────────────┬────────────┘
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
        ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
        │  backend-1   │    │  backend-2   │    │  backend-3   │
        │  Node + TS   │    │  Node + TS   │    │  Node + TS   │
        │  Socket.IO   │    │  Socket.IO   │    │  Socket.IO   │
        └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
               │                   │                   │
               └─────────┬─────────┴─────────┬─────────┘
                         ▼                   ▼
           ┌─────────────────┐ ┌───────────┐ ┌─────────────┐
           │ postgres-primary│◀┤ writes    │ │   Redis     │
           │   (writes)      │ └───────────┘ │  (pub/sub)  │
           └────────┬────────┘               └─────────────┘
                    │ WAL stream
                    ▼
           ┌─────────────────┐
           │ postgres-replica│
           │  (hot standby)  │
           └─────────────────┘
```

- **Nginx** distributes connections to three Node.js backends with `ip_hash`
  stickiness (so the WebSocket handshake survives) and automatic upstream
  failover.
- **Redis** is used by the Socket.IO Redis adapter so a message emitted on one
  node is delivered to a recipient connected to any other node — the backend
  is therefore **stateless** and horizontally scalable.
- **Postgres** stores users (with their public keys) and ciphertext-only message
  history. The server never has access to plaintext. The database tier is
  **replicated**: `postgres-primary` accepts all writes and streams every
  WAL record asynchronously to `postgres-replica`, a hot-standby that holds
  a continuously updated copy of the ciphertext. See
  [`docs/database-replication.md`](docs/database-replication.md).

## Tech stack

- Backend: Node.js, Express, Socket.IO, `@socket.io/redis-adapter`, Prisma, TypeScript
- Frontend: React, Vite, TypeScript, `libsodium-wrappers`
- Storage: PostgreSQL 16, Redis 7
- Load balancer: Nginx
- Orchestration: Docker Compose (Proxmox for thesis deployment, later phase)

## Project layout

```
chat-app/
├── docker-compose.yml
├── nginx/                 # load balancer config
├── backend/               # Node.js + Express + Socket.IO
│   ├── prisma/            # schema + migrations
│   └── src/
├── frontend/              # React + Vite + libsodium
└── docs/                  # e2ee scheme, threat model
```

## Local development

### Prerequisites

- Docker Desktop (or any recent Docker Engine with Compose v2)
- Node.js 20+ if you want to run the frontend dev server outside Docker

### First-time setup

```bash
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Edit the `.env` files and replace `JWT_SECRET` with a long random string
(the same value must appear in the root `.env` and `backend/.env`).

### Bring up the stack

```bash
docker compose up --build
```

This starts:

| Service           | Address                | Notes                                |
|-------------------|------------------------|--------------------------------------|
| Nginx             | http://localhost:8080  | Entry point for HTTP and WS          |
| backend-1/2/3     | internal               | Reached only via Nginx               |
| postgres-primary  | internal               | RW. Volume: `postgres_primary_data`  |
| postgres-replica  | internal               | RO hot standby. Volume: `postgres_replica_data` |
| Redis             | internal               | Socket.IO pub/sub                    |

### Run the initial database migration

The first time you bring the stack up, create the schema on **the primary**
(Prisma is configured to talk to `postgres-primary`; the replica receives
the migration automatically through the WAL stream):

```bash
docker compose exec backend-1 npx prisma migrate dev --name init
```

Regenerate the Prisma client after any schema change:

```bash
docker compose exec backend-1 npx prisma generate
```

> **Upgrading from Phase 4.** Phase 5 renames the database service from
> `postgres` to `postgres-primary` and introduces a separate replica
> volume. Existing volumes from earlier phases do not include the
> replication role created by `infra/postgres/primary-init.sh`, which runs
> only during `initdb`. The simplest upgrade is
> `docker compose down -v && docker compose up --build -d`, followed by a
> fresh `prisma migrate dev`. If keeping existing data matters, create the
> role manually with `psql` instead.

### Run the frontend dev server

You can use the bundled `frontend` image, or run Vite locally for a faster loop:

```bash
cd frontend
npm install
npm run dev
# open http://localhost:5173
```

The frontend talks to `http://localhost:8080`, which is Nginx, which fans out
to the three backend nodes.

## How to demo (Alice & Bob walkthrough)

This is the script for the thesis defence. It exercises every part of the
system — distributed topology, automatic failover, end-to-end encryption,
and the encrypted-only-storage guarantee — in roughly five minutes.

### 1. Start the Docker stack

```bash
docker compose up --build -d
docker compose ps
```

Wait until all six services (`postgres`, `redis`, `backend-1/2/3`, `nginx`)
report `healthy`.

### 2. Sync the Prisma schema

First-time setup creates the `User` and `Message` tables:

```bash
docker compose exec backend-1 npx prisma migrate dev --name init
```

(Non-interactive equivalent for CI / scripts:
`docker compose exec -T backend-1 npx prisma db push --skip-generate`.)

### 3. Start the frontend

```bash
cd frontend
npm install
npm run dev
# open http://localhost:5173
```

### 4. Register Alice and Bob

Open the frontend in **two separate browsers** (or one normal window + one
private window). Each browser has its own IndexedDB, which is where the
private key is stored — registering the second user in the same browser
would overwrite the first user's local key.

- In browser A, register `alice` (any email, any password ≥ 8 chars).
- In browser B, register `bob`.

Behind the scenes, each browser:

- Generates a fresh X25519 keypair locally (`crypto_box_keypair`).
- Uploads only the public key to the server.
- Stores the private key in IndexedDB, keyed by user id.

The server now knows: two users exist, each with a public key. It does not
have either private key, and could not get one even if it tried.

### 5. Send encrypted messages

In Alice's browser, click on Bob in the user list. The chat panel opens. Type
a message and press send.

What the frontend does:

1. Encrypts the plaintext to Bob's public key → `ciphertextForRecipient`.
2. Encrypts the same plaintext to Alice's own public key → `ciphertextForSender`.
3. Emits `message:send { recipientId, ciphertextForRecipient, ciphertextForSender }`
   over the Socket.IO connection.

What Bob sees: the message appears in real time. What the server saw and
stored: two opaque base64 blobs and the algorithm tag — no plaintext.

Send a few more messages in both directions. Reload Alice's browser to prove
that history decrypts correctly on session restart (Alice decrypts the
`ciphertextForSender` field for messages she sent, and the
`ciphertextForRecipient` field for messages Bob sent her).

### 6. Stop a backend node — show failover

In a terminal:

```bash
docker compose stop backend-1
```

The frontend reconnects automatically. Click the "check" button next to
`health:` in the chat header — the `nodeId` now reports `node-2` or `node-3`.
Messages continue to flow in both directions. Nginx's `proxy_next_upstream`
re-routed the next connection to a surviving upstream; the Redis adapter
ensured the in-flight chat continues to work because no node holds
session state locally.

Restart the node:

```bash
docker compose start backend-1
```

For the full failover discussion (three scenarios — process kill, container
stop, host pull), see [`docs/proxmox-deployment.md`](docs/proxmox-deployment.md).

### 7. Show that the database holds only ciphertext

After Alice and Bob have exchanged some messages, dump the `Message` table
from the primary:

```bash
docker compose exec postgres-primary \
  psql -U chat -d chat \
  -c 'SELECT id, "senderId", "recipientId", algorithm,
             left("ciphertextForRecipient", 32) AS recip_ct_head,
             left("ciphertextForSender",    32) AS send_ct_head,
             "createdAt"
        FROM "Message"
        ORDER BY "createdAt" DESC
        LIMIT 5;'
```

Every row shows two base64 ciphertext columns and zero plaintext columns —
because no plaintext column exists in the schema. For a stronger informal
proof, type a unique sentinel like `the-cake-is-a-lie-2026` into the chat
and then grep the dump for it:

```bash
docker compose exec postgres-primary \
  pg_dump -U chat -d chat --data-only --table='"Message"' \
  | grep -i 'the-cake-is-a-lie-2026' \
  || echo 'sentinel not found in any column — server stored only ciphertext'
```

Expected output: the `sentinel not found ...` message. See
[`docs/database-model.md`](docs/database-model.md) for the full schema
walkthrough.

### 8. Show that the encrypted history is replicated

Run the same query against `postgres-replica` and confirm the rows are
already there:

```bash
docker compose exec postgres-replica \
  psql -U chat -d chat \
  -c 'SELECT id, "senderId", "recipientId",
             left("ciphertextForRecipient", 32) AS recip_ct_head,
             "createdAt"
        FROM "Message"
        ORDER BY "createdAt" DESC
        LIMIT 5;'
```

For a byte-for-byte comparison, hash one row's ciphertext on each side and
verify they match:

```bash
docker compose exec postgres-primary \
  psql -U chat -d chat -tAc \
  'SELECT md5("ciphertextForRecipient") FROM "Message" ORDER BY "createdAt" DESC LIMIT 1;'

docker compose exec postgres-replica \
  psql -U chat -d chat -tAc \
  'SELECT md5("ciphertextForRecipient") FROM "Message" ORDER BY "createdAt" DESC LIMIT 1;'
```

Finally confirm one server is writable and one is in standby:

```bash
docker compose exec postgres-primary psql -U chat -d chat -tAc 'SELECT pg_is_in_recovery();'  # f
docker compose exec postgres-replica psql -U chat -d chat -tAc 'SELECT pg_is_in_recovery();'  # t
```

The full discussion lives in
[`docs/database-replication.md`](docs/database-replication.md).

## Database replication

The PostgreSQL tier runs as a primary + hot-standby pair:

- `postgres-primary` accepts all application writes and streams its WAL to
  the replica.
- `postgres-replica` re-applies that WAL continuously and serves read-only
  queries (`SELECT` works, any `INSERT`/`UPDATE`/`DELETE` is rejected).
- The replication role and the `pg_hba.conf` rule are provisioned by
  `infra/postgres/primary-init.sh` (run by `initdb` on first start of the
  primary).
- The replica's data directory is cloned from the primary by `pg_basebackup`
  on first boot of `postgres-replica`, driven by
  `infra/postgres/replica-entrypoint.sh`.

Because replication operates below the application layer, both servers hold
the same ciphertext byte-for-byte and neither holds plaintext — the
end-to-end encryption guarantee is preserved on the replica.

### Verify replication

```bash
# 1. Both servers see the same encrypted history.
docker compose exec postgres-primary psql -U chat -d chat \
  -c 'SELECT count(*) FROM "Message";'
docker compose exec postgres-replica psql -U chat -d chat \
  -c 'SELECT count(*) FROM "Message";'

# 2. Roles: primary writable, replica in standby.
docker compose exec postgres-primary psql -U chat -d chat -tAc 'SELECT pg_is_in_recovery();'  # f
docker compose exec postgres-replica psql -U chat -d chat -tAc 'SELECT pg_is_in_recovery();'  # t

# 3. The primary sees a streaming connection from the replica.
docker compose exec postgres-primary psql -U chat -d chat \
  -c "SELECT application_name, client_addr, state, sync_state,
             pg_wal_lsn_diff(sent_lsn, replay_lsn) AS lag_bytes
        FROM pg_stat_replication;"

# 4. The replica refuses writes.
docker compose exec postgres-replica psql -U chat -d chat \
  -c "INSERT INTO \"User\" (id, username, email, \"passwordHash\", \"publicKey\")
      VALUES ('x','x','x','x','x');"
# expected: ERROR:  cannot execute INSERT in a read-only transaction
```

See [`docs/database-replication.md`](docs/database-replication.md) for the
full design, Proxmox mapping, and failover discussion.

## Demoing the distributed behavior (lower level)

**Load balancing** — hit the health endpoint repeatedly and observe the
node id returned (a single client IP is pinned to one upstream via `ip_hash`,
which is the property that keeps WebSockets working; switching to
`least_conn` in `nginx/nginx.conf` lets a single client see all three nodes):

```bash
curl http://localhost:8080/health
curl http://localhost:8080/health
curl http://localhost:8080/health
```

**Cross-node Socket.IO** — open the frontend in two browsers on different
client IPs. Each "check" button reveals which `nodeId` answered. Messages
delivered between them go through Redis pub/sub, not direct in-memory
delivery, which is what makes the backend horizontally scalable.

## Documentation

- [`docs/e2ee.md`](docs/e2ee.md) — the educational E2EE scheme, threat
  model, and explicit list of what this protocol does *not* provide.
- [`docs/database-model.md`](docs/database-model.md) — `User` and `Message`
  schema, why two ciphertext columns exist, why no plaintext and no nonce
  column.
- [`docs/database-replication.md`](docs/database-replication.md) — the
  primary + hot-standby PostgreSQL setup, how WAL streaming preserves the
  encryption guarantee, failover behaviour, and the Proxmox mapping.
- [`docs/api-and-socket-contract.md`](docs/api-and-socket-contract.md) —
  authoritative reference for REST endpoints, Socket.IO events, request and
  response examples, and error codes.
- [`docs/runtime-verification.md`](docs/runtime-verification.md) — the full
  list of checks (Docker bring-up, Prisma sync, `/health`, failover, auth,
  user list, public key lookup, encrypted send/receive, history decrypt,
  negative tests) and the observed results.
- [`docs/proxmox-deployment.md`](docs/proxmox-deployment.md) — the
  Compose → Proxmox mapping, six-guest LXC layout, network plan, failover
  scenarios, and thesis defence narrative.

## Project status

- **Phase 1 — Foundation.** Repo structure, Docker topology, Prisma schema,
  `/health`, registration + login + public-key registration, JWT-authenticated
  Socket.IO, Redis adapter, libsodium key generation on the client. ✅ done.
- **Phase 2 — Encrypted 1:1 direct messaging.** `GET /users`,
  `GET /messages/:recipientId`, Socket.IO `message:send` with dual
  ciphertexts, per-user rooms, cross-node delivery, encrypted history fetch,
  React user list and chat UI. ✅ done.
- **Phase 3 — Thesis & demo readiness.** Documentation (this file and
  everything in `docs/`), reproducible demo script, encrypted-DB
  demonstration. ✅ done.
- **Phase 4 — Delivery and read receipts.** `deliveredAt` / `readAt`
  columns, `message:delivered` / `message:read` / `message:status` events,
  Sent / Delivered / Read indicators in the UI. ✅ done.
- **Phase 5 — Database replication.** `postgres-primary` + `postgres-replica`
  via PostgreSQL streaming replication, encrypted history visible
  byte-for-byte on both servers. ✅ done.
- **Out of scope for v1.** Group chat, file upload, message pagination
  beyond the 200-row cap, key rotation, multi-device key sync, forward
  secrecy, production-grade Nginx (TLS, rate limiting), automated tests,
  automatic database failover (replica must be promoted manually).

## Proxmox deployment plan

Docker Compose is the development convenience used to iterate quickly on a
laptop. The **production / thesis deployment target is Proxmox VE**, where the
same architecture is deployed across six isolated guests (one load balancer,
three backend nodes, one shared data guest for Postgres + Redis, and an
optional frontend guest) on a dedicated private bridge.

See [`docs/proxmox-deployment.md`](docs/proxmox-deployment.md) for the full
plan, covering:

- Why Docker Compose for local development and how it maps 1:1 to Proxmox.
- Recommended LXC / VM layout, sizing, and OS templates.
- Private-network IP plan and firewall rules.
- Per-node environment variables and a systemd unit example.
- Step-by-step provisioning order.
- The three failover test scenarios (process kill, LXC stop, host pull).
- How the deployment story is presented in the thesis defence.

## Scripts

| Command                                                    | What it does                  |
|------------------------------------------------------------|-------------------------------|
| `docker compose up --build`                                | Build and start everything    |
| `docker compose logs -f backend-2`                         | Tail one node's logs          |
| `docker compose stop backend-2`                            | Simulate node failure         |
| `docker compose exec backend-1 npx prisma migrate dev`     | Apply schema migrations       |
| `docker compose exec backend-1 npx prisma studio`          | Open Prisma Studio            |
| `docker compose exec postgres-primary psql -U chat -d chat -c 'SELECT id, "senderId", "recipientId", algorithm, left("ciphertextForRecipient", 32) FROM "Message" ORDER BY "createdAt" DESC LIMIT 5;'` | Check encrypted rows on the primary |
| `docker compose exec postgres-replica psql -U chat -d chat -c 'SELECT count(*) FROM "Message";'` | Check the replica's row count matches |
| `docker compose down -v`                                   | Tear down + wipe the DB       |

## License

Educational use, university final project.
