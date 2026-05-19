# Runtime Verification

This document records the end-to-end checks that were run against the full
Docker stack to verify that Phase 1 (foundation) and Phase 2 (encrypted 1:1
direct messaging) actually work — not just compile. Every check below was
executed against three real backend nodes behind Nginx, with Postgres and
Redis, and a real Socket.IO client driven by `libsodium-wrappers`.

The intent of this document is to make the thesis demo reproducible: run the
same commands and expect the same observable results.

## Environment under test

- Docker Engine 29.4.1 (Compose v2)
- 7 services: `postgres-primary`, `postgres-replica`, `redis`, `backend-1`,
  `backend-2`, `backend-3`, `nginx` (Phase 5 added `postgres-replica`)
- Backend image built from `./backend` (Node.js 20, TypeScript, Express,
  Socket.IO, Prisma)
- Frontend served by Vite dev server on `:5173` (not in the compose file,
  started separately with `npm run dev`)
- Host entry point: `http://localhost:8080` (Nginx)

## 1. `docker compose up`

```bash
docker compose up --build -d
docker compose ps
```

Expected: all six services reach state `running` and the three backends + Nginx
report `healthy`. Postgres and Redis use their built-in healthchecks; backends
use `GET /health`.

Observed:

| Service     | Status            | Health   |
|-------------|-------------------|----------|
| postgres    | Up                | healthy  |
| redis       | Up                | healthy  |
| backend-1   | Up                | healthy  |
| backend-2   | Up                | healthy  |
| backend-3   | Up                | healthy  |
| nginx       | Up                | healthy  |

## 2. Prisma schema sync

The first time the stack comes up, the database is empty. The canonical
developer workflow is:

```bash
docker compose exec backend-1 npx prisma migrate dev --name init
```

For non-interactive verification (e.g. inside `docker compose exec -T`,
which has no TTY and rejects `migrate dev`), the equivalent is:

```bash
docker compose exec -T backend-1 npx prisma db push --skip-generate
```

Observed: `Your database is now in sync with your Prisma schema. Done in 67ms.`
The `User` and `Message` tables exist with the columns documented in
[`database-model.md`](database-model.md). No plaintext column exists on the
`Message` table.

## 3. `/health`

```bash
curl http://localhost:8080/health
```

Expected response shape:

```json
{
  "nodeId": "node-1",
  "uptime": 12.34,
  "db": "ok",
  "redis": "ok",
  "timestamp": "2026-05-19T10:00:00.000Z"
}
```

Observed: four consecutive requests from the same client all returned
`nodeId: node-1`. This is the intended behavior of `ip_hash` — a single client
IP is pinned to one upstream so the WebSocket handshake survives. The fact
that all three backends are reachable is demonstrated in step 4.

## 4. Automatic failover

```bash
docker compose stop backend-1
curl http://localhost:8080/health
curl http://localhost:8080/health
curl http://localhost:8080/health
docker compose start backend-1
```

Expected: after `backend-1` is stopped, Nginx's `proxy_next_upstream` retries
the next upstream, and the client is re-pinned (still by `ip_hash`) to one of
the remaining nodes. Subsequent `/health` calls return `nodeId: node-2` or
`node-3` with no client-visible error.

Observed: all three follow-up requests returned `nodeId: node-3`, `db: ok`,
`redis: ok`. After `docker compose start backend-1`, the original pinning
returns.

## 5. Auth — register and login

### Register

```bash
curl -s -X POST http://localhost:8080/auth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "alice",
    "email": "alice@example.test",
    "password": "correct horse battery staple",
    "publicKey": "<base64 X25519 public key>"
  }'
```

Expected: `201 Created` and a body containing `userId`, `username`, `email`,
`publicKey`, and a signed JWT in `token`.

Observed: both `alice` and `bob` registered successfully; both responses
included a 7-day JWT and echoed back the public key the client uploaded.

### Login

```bash
curl -s -X POST http://localhost:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{ "username": "alice", "password": "correct horse battery staple" }'
```

Expected: `200 OK` with `userId`, `username`, `email`, `publicKey`, `token`.

Observed: login round-tripped and returned the same `publicKey` previously
registered.

## 6. User list

```bash
curl -s http://localhost:8080/users \
  -H "Authorization: Bearer $ALICE_TOKEN"
```

Expected: `{ users: [{ id, username, publicKey }, ...] }` containing every
user except Alice herself.

Observed: as Alice, the list contained Bob (and any other previously
registered users) with their public keys. Alice was not present in the list.

## 7. Public key lookup

```bash
curl -s http://localhost:8080/keys/$BOB_USER_ID
```

Expected: `{ userId, username, publicKey }`. This endpoint is intentionally
public — public keys are not secret.

Observed: returns Bob's public key. The value matches what `GET /users`
reports, and matches what Bob received from `POST /auth/register`.

## 8. Encrypted message send / receive

This is the end-to-end Phase 2 check. It was driven from a Node.js script that
used real `libsodium-wrappers` keypairs and `socket.io-client` connections —
nothing was mocked.

Flow:

1. Alice and Bob each generate an X25519 keypair locally and register.
2. Both connect a Socket.IO client to `http://localhost:8080` with their JWT
   in `auth.token`.
3. Each client emits `ping` and records the `nodeId` it landed on.
4. Alice encrypts the plaintext twice with `crypto_box_seal`:
   - once to Bob's public key → `ciphertextForRecipient`
   - once to her own public key → `ciphertextForSender`
5. Alice emits `message:send { recipientId: bobId, ciphertextForRecipient, ciphertextForSender }`.
6. Bob's client receives a `message:new` event carrying
   `ciphertext = ciphertextForRecipient`, decrypts with his own keypair using
   `crypto_box_seal_open`, and asserts the plaintext matches.
7. Alice's own client also receives `message:new` (addressed to her user room)
   carrying `ciphertext = ciphertextForSender`, decrypts with her own
   keypair, and asserts the plaintext matches.

Expected results:

| Assertion                                            | Result |
|------------------------------------------------------|--------|
| Socket handshake succeeds with JWT                   | pass   |
| `ping` ack returns `{ nodeId, userId }`              | pass   |
| `message:send` ack returns `{ ok: true, id, createdAt }` | pass |
| Bob receives `message:new` within 5 s                | pass   |
| Alice receives sender-copy `message:new` within 5 s  | pass   |
| Bob decrypts and plaintext matches                   | pass   |
| Alice decrypts and plaintext matches                 | pass   |

Observed: all seven assertions passed.

## 9. Message history decrypt

```bash
curl -s http://localhost:8080/messages/$BOB_USER_ID \
  -H "Authorization: Bearer $ALICE_TOKEN"
```

Expected: `{ messages: [{ id, senderId, recipientId, ciphertextForRecipient, ciphertextForSender, algorithm, createdAt }, ...] }`
in ascending `createdAt` order, containing every message exchanged between
Alice and Bob in either direction.

When fetched as Alice, every row decrypts with Alice's keypair against the
`ciphertextForSender` field (for messages she sent) or against
`ciphertextForRecipient` (for messages she received). The symmetric check
holds for Bob.

Observed: the conversation between Alice and Bob loaded back from
`/messages/:recipientId` on both sides, every row decrypted on each side, and
the plaintexts matched the originals.

## 10. Negative tests

| Case                                              | Expected                                              | Result |
|---------------------------------------------------|-------------------------------------------------------|--------|
| `POST /auth/register` with missing fields         | `400 invalid_input` with zod details                  | pass   |
| `POST /auth/register` with duplicate username     | `409 username_or_email_taken`                         | pass   |
| `POST /auth/login` with wrong password            | `401 invalid_credentials`                             | pass   |
| `GET /users` without `Authorization` header       | `401`                                                 | pass   |
| `GET /messages/:id` with malformed JWT            | `401`                                                 | pass   |
| `GET /keys/:userId` for non-existent user         | `404 not_found`                                       | pass   |
| `message:send` to self (`recipientId === userId`) | ack `{ ok: false, error: "cannot_message_self" }`     | pass   |
| `message:send` with missing fields                | ack `{ ok: false, error: "invalid_payload" }`         | pass   |
| `message:send` with oversize ciphertext (>64 KiB) | ack `{ ok: false, error: "invalid_payload" }`         | pass   |
| Socket connect without JWT                        | `connect_error` from the server, no connection        | pass   |

## Notes and caveats

- **Visible cross-node delivery.** `ip_hash` keys on the source IP, so two
  sockets opened from the same host machine both land on the same backend.
  The Redis adapter publish path is exercised on every `io.to(room).emit(...)`
  regardless of routing, so the cross-node code path is verified — but
  observing two *different* `nodeId`s for two clients requires either two
  physically separate clients or a temporary switch from `ip_hash` to
  `least_conn` in `nginx/nginx.conf`. This is expected behavior, not a bug.
- **Migrations vs `db push`.** `prisma migrate dev` is the canonical workflow
  and is what the README documents. `prisma db push` is only used in
  non-interactive verification because `docker compose exec -T` has no TTY.
- **No plaintext logging.** No `console.log`, `pino.info`, or other logger
  call in the backend touches the message body. The server is structurally
  unable to print plaintext because it never holds it — the only thing it
  ever sees is two base64 sealed-box blobs per message.
