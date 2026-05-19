# API and Socket.IO Contract

This document is the authoritative reference for the HTTP and Socket.IO
surface exposed by the backend. Every endpoint listed here is implemented and
covered by the verification in [`runtime-verification.md`](runtime-verification.md).

- Base URL in development: `http://localhost:8080` (Nginx in front of the
  three backend nodes)
- All request and response bodies are JSON (`application/json`).
- All endpoints that require authentication accept a JWT in the
  `Authorization: Bearer <token>` header.
- Tokens are issued by `POST /auth/register` and `POST /auth/login` and are
  valid for 7 days. The signing secret (`JWT_SECRET`) is shared by every
  backend node, which is what keeps the backend stateless.

## Conventions

- `string` field types are UTF-8 strings.
- Binary fields (public keys, sealed-box ciphertext) are **base64-encoded**
  strings on the wire.
- `createdAt` is an ISO-8601 UTC timestamp.
- IDs are CUID strings issued by Prisma.

## Error response shape

Every error response is a JSON object with a stable `error` code suitable for
machine comparison, and optionally a `details` field for validation errors:

```json
{ "error": "invalid_input", "details": { "fieldErrors": { "...": ["..."] } } }
```

Known error codes used by the API:

| Code                          | HTTP | Where                       | Meaning                                 |
|-------------------------------|------|-----------------------------|-----------------------------------------|
| `invalid_input`               | 400  | every POST                  | zod validation failed                   |
| `invalid_credentials`         | 401  | `POST /auth/login`          | Wrong username or password              |
| `missing_token`               | 401  | any auth-required route     | No `Authorization` header               |
| `invalid_token`               | 401  | any auth-required route     | JWT not parseable or signature invalid  |
| `username_or_email_taken`     | 409  | `POST /auth/register`       | Prisma unique-constraint violation      |
| `not_found`                   | 404  | `GET /keys/:userId`         | No user with that id                    |
| `cannot_message_self`         | n/a  | `message:send` ack          | `recipientId === self`                  |
| `invalid_payload`             | n/a  | `message:send` / `message:delivered` / `message:read` ack | zod validation failed |
| `persist_failed`              | n/a  | `message:send` ack          | DB insert failed                        |
| `not_recipient_or_not_found`  | n/a  | `message:delivered` / `message:read` ack | Caller is not the recipient of that message, or the id does not exist |
| `update_failed`               | n/a  | `message:delivered` / `message:read` ack | DB update failed                |

---

## HTTP endpoints

### `GET /health`

Returns liveness info for the node that handled the request.

**Auth:** none.

**Response 200:**

```json
{
  "nodeId": "node-2",
  "uptime": 124.31,
  "db": "ok",
  "redis": "ok",
  "timestamp": "2026-05-19T10:00:00.000Z"
}
```

`db` and `redis` are `"ok"` or `"down"` depending on a `SELECT 1` round-trip
to Postgres and a `PING` to Redis.

---

### `POST /auth/register`

Register a new user. The client generates the X25519 keypair locally and
uploads only the public key.

**Auth:** none.

**Request:**

```json
{
  "username": "alice",
  "email": "alice@example.test",
  "password": "correct horse battery staple",
  "publicKey": "L8C9... (base64)"
}
```

Constraints (enforced server-side):

- `username`: 3–32 chars, `[a-zA-Z0-9_.-]`, must be unique
- `email`: valid email format, must be unique
- `password`: 8–128 chars (hashed with Argon2id before storage)
- `publicKey`: 16–256 chars (base64 X25519, typically ~44 chars)

**Response 201:**

```json
{
  "userId": "ckxyz...",
  "username": "alice",
  "email": "alice@example.test",
  "publicKey": "L8C9...",
  "token": "eyJhbGc..."
}
```

**Errors:** `400 invalid_input`, `409 username_or_email_taken`.

---

### `POST /auth/login`

**Auth:** none.

**Request:**

```json
{ "username": "alice", "password": "correct horse battery staple" }
```

**Response 200:**

```json
{
  "userId": "ckxyz...",
  "username": "alice",
  "email": "alice@example.test",
  "publicKey": "L8C9...",
  "token": "eyJhbGc..."
}
```

**Errors:** `400 invalid_input`, `401 invalid_credentials`.

---

### `GET /keys/:userId`

Fetch a user's public key. Used by the client before encrypting a message to
a user whose key it does not already have cached.

**Auth:** none (public keys are public).

**Response 200:**

```json
{
  "userId": "ckxyz...",
  "username": "bob",
  "publicKey": "Mq8d..."
}
```

**Errors:** `404 not_found`.

---

### `GET /users`

List every registered user except the caller, including each user's public
key so the client can immediately encrypt a message without a follow-up
round-trip.

**Auth:** required.

**Response 200:**

```json
{
  "users": [
    { "id": "ckabc...", "username": "bob",   "publicKey": "Mq8d..." },
    { "id": "ckdef...", "username": "carol", "publicKey": "Nr1f..." }
  ]
}
```

**Errors:** `401 missing_token`, `401 invalid_token`.

---

### `GET /messages/:recipientId`

Return the full encrypted message history between the caller and
`:recipientId`, in ascending `createdAt` order, capped at 200 rows.

**Auth:** required.

**Response 200:**

```json
{
  "messages": [
    {
      "id": "cmsg1...",
      "senderId": "ckxyz...",
      "recipientId": "ckabc...",
      "ciphertextForRecipient": "base64...",
      "ciphertextForSender": "base64...",
      "algorithm": "x25519-xsalsa20poly1305-sealedbox",
      "createdAt": "2026-05-19T10:01:23.456Z",
      "deliveredAt": "2026-05-19T10:01:24.012Z",
      "readAt": null
    }
  ]
}
```

Both ciphertexts are returned for every row. The client picks the one it can
actually decrypt:

- For rows where `senderId === self.id`, decrypt `ciphertextForSender`.
- Otherwise, decrypt `ciphertextForRecipient`.

`deliveredAt` and `readAt` are server-assigned receipt timestamps. Both are
`null` until the recipient transitions them via `message:delivered` /
`message:read` (see below). See [`database-model.md`](database-model.md)
for why two copies of the ciphertext exist.

**Errors:** `401 missing_token`, `401 invalid_token`.

---

### `GET /presence`

Return the current online/offline state of every user the caller is allowed
to see — for the v1 1:1-DM-only scope that means every user other than the
caller. The shape matches the Socket.IO `presence:update` event so a client
can fold the snapshot and the live stream into the same local state.

**Auth:** required.

**Response 200:**

```json
{
  "presence": [
    { "userId": "ckabc...", "online": true,  "lastSeenAt": null },
    { "userId": "ckdef...", "online": false, "lastSeenAt": "2026-05-19T10:00:00.000Z" }
  ]
}
```

- `online` is `true` while at least one of that user's sockets is connected
  to any of the three backend nodes.
- `lastSeenAt` is `null` while the user is online, and the ISO-8601
  timestamp of the moment their last socket disconnected once they are
  offline. Users who have never connected return `online:false,
  lastSeenAt:null`.

**Errors:** `401 missing_token`, `401 invalid_token`.

---

## Socket.IO

Path: `/socket.io` (proxied through Nginx).

### Connecting

The client connects with the JWT in the handshake `auth` object:

```ts
io('http://localhost:8080', { auth: { token: '<jwt>' } });
```

The server validates the token in a connection middleware and rejects the
handshake with a `connect_error` if the token is missing or invalid. On
success, the socket is automatically joined to its own user room
(`user:<userId>`) so the server can address it by user id without tracking
socket-to-user mapping itself. The Redis adapter ensures the `user:<userId>`
room is reachable from any backend node.

### Event: `ping` (client → server, with ack)

A round-trip event used to confirm cross-node connectivity and to report
which backend node terminated the WebSocket.

```ts
socket.emit('ping', (reply) => {
  // reply: { nodeId: 'node-2', userId: 'ckxyz...' }
});
```

The server also emits a `pong` event with the same payload, for clients that
prefer event-based observation over acks.

### Event: `message:send` (client → server, with ack)

Send an encrypted direct message. The client must have already produced two
sealed-box ciphertexts of the same plaintext: one sealed to the recipient's
public key, and one sealed to its own public key (so the sender can read
their own history later — sealed boxes are one-way).

**Payload:**

```ts
{
  recipientId: string,            // CUID of the recipient
  ciphertextForRecipient: string, // base64, sealed to recipient.publicKey
  ciphertextForSender: string     // base64, sealed to sender.publicKey
}
```

Server-side validation (zod):

- `recipientId`: non-empty string
- `ciphertextForRecipient`: 1–65 536 chars
- `ciphertextForSender`: 1–65 536 chars
- `recipientId !== self.userId`

**Ack on success:**

```json
{ "ok": true, "id": "cmsg1...", "createdAt": "2026-05-19T10:01:23.456Z" }
```

**Ack on failure:**

```json
{ "ok": false, "error": "invalid_payload" | "cannot_message_self" | "persist_failed" }
```

On success, the server:

1. Persists one `Message` row containing both ciphertexts.
2. Emits `message:new` to `user:<recipientId>` with
   `ciphertext = ciphertextForRecipient`.
3. Emits `message:new` to `user:<senderId>` with
   `ciphertext = ciphertextForSender`.

Step 2 and step 3 go through the Redis adapter so they reach the recipient
and the sender regardless of which backend node holds their sockets.

### Event: `message:new` (server → client)

Pushed to a user when a message is delivered to them, and also pushed to the
sender as confirmation (with their own decryptable copy).

**Payload:**

```ts
{
  id: string,
  senderId: string,
  recipientId: string,
  ciphertext: string,             // the copy the receiving client can decrypt
  algorithm: string,              // e.g. "x25519-xsalsa20poly1305-sealedbox"
  createdAt: string,              // ISO-8601
  deliveredAt: string | null,     // receipt timestamps (initially null)
  readAt: string | null
}
```

The client decrypts `ciphertext` with its own keypair using
`crypto_box_seal_open`. The client must already know its own public and
private key (the private key never leaves the browser; it lives in
IndexedDB).

### Event: `message:delivered` (client → server, with ack)

Mark a received message as delivered. Only the recipient of the message can
transition this field. Idempotent: re-sending after `deliveredAt` is already
set does not change anything and is acked `{ ok: true }`.

**Payload:**

```ts
{ messageId: string }
```

**Ack on success:** `{ "ok": true }`. **Ack on failure:**

```json
{ "ok": false, "error": "invalid_payload" | "not_recipient_or_not_found" | "update_failed" }
```

On success the server emits `message:status` to both ends of the
conversation (see below).

### Event: `message:read` (client → server, with ack)

Mark a received message as read. Only the recipient can transition this
field. A read receipt implies delivery, so the server backfills
`deliveredAt` to the same timestamp as `readAt` if it was still `null`.
Idempotent on re-emit.

**Payload:**

```ts
{ messageId: string }
```

**Ack on success:** `{ "ok": true }`. **Ack on failure:**

```json
{ "ok": false, "error": "invalid_payload" | "not_recipient_or_not_found" | "update_failed" }
```

On success the server emits `message:status` to both ends of the
conversation (see below).

### Event: `message:status` (server → both ends)

Pushed to the sender and the recipient of a message whenever either of its
receipt timestamps changes.

**Payload:**

```ts
{
  messageId: string,
  deliveredAt: string | null,
  readAt: string | null
}
```

Clients should treat this as a patch against their local copy of the
message row (matched by `messageId`).

### Event: `presence:update` (server → all sockets in the `presence` room)

Every authenticated socket auto-joins a global `presence` room on connect.
The server publishes a `presence:update` whenever a user transitions from
offline to online (their first socket connects across all backend nodes) or
from online to offline (their last socket disconnects).

**Payload:**

```ts
{
  userId: string,
  online: boolean,
  lastSeenAt: string | null    // null while online; ISO-8601 once offline
}
```

The 0→1 / 1→0 gating means multiple tabs from the same user produce only
two events total — one online, one offline — not one per tab. Cross-node
delivery is handled by the Redis adapter.

### Event: `typing:start` / `typing:stop` (client → server)

Tell the server that the caller has started or stopped typing in their
conversation with a given recipient. No ack. Self-targeting is dropped
silently; malformed payloads (missing `recipientId`, etc.) are dropped
silently. Nothing is persisted to the database and the server logs no
typing content.

**Payload:**

```ts
{ recipientId: string }
```

On a valid event the server emits a corresponding `typing:update` to the
recipient's user room (only — typing is not echoed back to the sender).

### Event: `typing:update` (server → recipient's user room)

Push that tells a user one of their peers has started or stopped typing in
their direct conversation.

**Payload:**

```ts
{
  userId: string,    // the sender of the typing event
  typing: boolean
}
```

Cross-node delivery is again handled by the Redis adapter.

---

## What the server never sees

For completeness, here is what the server is structurally unable to observe:

- The plaintext message body.
- The sender's or recipient's private key.
- Any data derived from the plaintext (no search index, no preview, no length
  obfuscation — but the server has no plaintext to derive these from).

What the server *does* see, and stores:

- Sender id, recipient id, two ciphertext blobs, the algorithm tag, the
  timestamp, and the message id.

This is the property that makes the scheme end-to-end encrypted. See
[`e2ee.md`](e2ee.md) for the full threat model and limitations.
