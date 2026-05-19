# Database Model

The application uses PostgreSQL through Prisma. The schema lives in
[`backend/prisma/schema.prisma`](../backend/prisma/schema.prisma) and contains
exactly two models: `User` and `Message`. Both models are minimal on purpose
— the simplicity is part of the thesis argument that end-to-end encryption
doesn't require a complicated server schema.

## `User`

```prisma
model User {
  id           String   @id @default(cuid())
  username     String   @unique
  email        String   @unique
  passwordHash String
  publicKey    String
  createdAt    DateTime @default(now())

  sentMessages     Message[] @relation("sender")
  receivedMessages Message[] @relation("recipient")
}
```

| Column         | Purpose                                                                                       |
|----------------|-----------------------------------------------------------------------------------------------|
| `id`           | CUID, primary key, used as the room name (`user:<id>`) for Socket.IO addressing.              |
| `username`     | Unique display handle, used at login.                                                         |
| `email`        | Unique, currently used only for account identity (future: password reset).                    |
| `passwordHash` | Argon2id hash of the password. The plaintext password is never stored or logged.              |
| `publicKey`    | base64-encoded X25519 public key, uploaded by the client at registration.                     |
| `createdAt`    | Timestamp set by Prisma.                                                                      |

Two unique indexes are created automatically by `@unique` on `username` and
`email`.

### Why the public key lives in the user row

The public key is, by definition, public. Storing it on the user row gives
every client a single round-trip to fetch every key it needs:

- `GET /users` returns the public key of every other user.
- `GET /keys/:userId` returns one user's public key.

No separate "keys" table is needed for the v1 model (one keypair per user,
no rotation, no multi-device). If key rotation is added later, this column
would move to a `UserKey` table with `(userId, fingerprint, createdAt,
retiredAt)`.

### Why the private key is *not* here

The private key never leaves the user's browser. It is generated on the
client at registration and persisted in IndexedDB under the user id (see
[`frontend/src/storage/keys.ts`](../frontend/src/storage/keys.ts)).
Sending the private key to the server — even transiently — would defeat the
entire end-to-end encryption claim, since at that moment the server (or any
attacker who reads the request log, or any operator with a Postgres
console) could decrypt every message.

The practical consequence is that **login only works on the device where you
registered**. This is the same trade-off Signal makes for its initial
identity registration; full multi-device support would require a separate
device-to-device key transfer protocol, which is out of scope (see
[`e2ee.md`](e2ee.md)).

## `Message`

```prisma
model Message {
  id          String   @id @default(cuid())
  senderId    String
  recipientId String

  ciphertextForRecipient String
  ciphertextForSender    String

  algorithm   String   @default("x25519-xsalsa20poly1305-sealedbox")
  createdAt   DateTime @default(now())

  sender    User @relation("sender",    fields: [senderId],    references: [id])
  recipient User @relation("recipient", fields: [recipientId], references: [id])

  @@index([recipientId, createdAt])
  @@index([senderId, createdAt])
}
```

| Column                   | Purpose                                                                              |
|--------------------------|--------------------------------------------------------------------------------------|
| `id`                     | CUID, primary key, returned to the client so live and historical messages can dedup. |
| `senderId`               | FK → `User.id`.                                                                      |
| `recipientId`            | FK → `User.id`.                                                                      |
| `ciphertextForRecipient` | base64 sealed box of the plaintext, sealed to the **recipient's** public key.        |
| `ciphertextForSender`    | base64 sealed box of the plaintext, sealed to the **sender's** public key.           |
| `algorithm`              | String tag identifying the crypto scheme used to produce both ciphertexts.           |
| `createdAt`              | Server-assigned timestamp. Ordering is by this column.                               |

Two composite indexes — `(recipientId, createdAt)` and
`(senderId, createdAt)` — make the conversation history query efficient:
`GET /messages/:recipientId` filters on either pair and orders by `createdAt`.

### Why there are two ciphertexts (`ciphertextForRecipient` + `ciphertextForSender`)

The crypto primitive is `crypto_box_seal` (libsodium "sealed boxes"). A
sealed box is **anonymous, one-way encryption**: the sender uses only the
recipient's public key, and an ephemeral keypair is generated and discarded
inside the function. The output blob embeds the ephemeral public key plus
the authenticated ciphertext, and only the recipient's *private* key can
open it.

That property is exactly what we want for transport — the server cannot
forge messages and cannot decrypt them — but it has one consequence:

> **The sender cannot decrypt their own message after sending it.**
> The ephemeral private key that was generated inside `crypto_box_seal` is
> thrown away. The sender has the plaintext at the moment they wrote it,
> but if they reload the page or open the app on another tab tomorrow,
> they would have no way to read their own outgoing history.

To fix this, the client encrypts the plaintext **twice** at send time:

1. Once to the recipient's public key → `ciphertextForRecipient`. The
   recipient decrypts this on receive and on history fetch.
2. Once to the sender's own public key → `ciphertextForSender`. The sender
   decrypts this on history fetch (and on the sender-copy of the live
   `message:new` event the server pushes back to them as confirmation).

Both ciphertexts are stored on the same row. The server still cannot
decrypt either of them — it has no private keys.

Other schemes can avoid the duplication:

- **Shared symmetric key per conversation.** Both parties derive (or agree
  on) a symmetric key once; every message uses that key. Both can decrypt
  with one ciphertext. This requires a key-agreement step (X25519 ECDH +
  HKDF) which is more code and one more thing to get wrong. Signal's
  Double Ratchet is essentially this with extra forward-secrecy properties.
- **Two-recipient `crypto_box`** (non-sealed). Same idea but requires
  managing nonces, which the sealed-box API hides.

We chose the dual-sealed-box approach because it is the simplest scheme
that gives the sender access to their own history while keeping the server
unable to decrypt anything. Educational E2EE first, protocol engineering
second — see [`e2ee.md`](e2ee.md).

### Why no plaintext is stored

There is no `content`, `body`, `text`, or `plaintext` column on the
`Message` model, and no other table holds message bodies. The application
layer never writes plaintext to disk or to logs. The server cannot violate
this invariant by accident because:

- The only `message:send` payload the server accepts is the two ciphertext
  fields plus `recipientId`. Plaintext is not part of the wire format.
- The server has no private keys with which to decrypt the ciphertext it
  does receive. It cannot derive plaintext even if it tried.
- The `pino` logger configuration is set to `info` and only emits HTTP
  metadata (method, path, status, duration). No log statement reads the
  request body or the stored ciphertext.

Verifying this property is a one-liner — see the demo SQL in the README
or the dedicated section [Checking that messages are encrypted in the
database](#checking-that-messages-are-encrypted-in-the-database) below.

### Why no `nonce` column is needed for sealed boxes

A symmetric cipher like XSalsa20-Poly1305 needs a nonce: a per-message
random or counter value that, combined with the key, makes the keystream
unique. With ordinary `crypto_box` you have to store (or transmit) the
nonce alongside the ciphertext, which usually means a separate column or a
fixed-width prefix.

`crypto_box_seal` is structured to make that unnecessary:

```
sealed_box(message, recipient_pk) =
  ephemeral_pk || crypto_box(message, recipient_pk, ephemeral_sk, nonce)
where
  ephemeral_keypair = newly generated for every call
  nonce             = blake2b(ephemeral_pk || recipient_pk)
```

Concretely:

- The **ephemeral public key** is generated fresh on every call and stored
  in the first 32 bytes of the blob.
- The **nonce** is *deterministically derived* from `ephemeral_pk` and
  `recipient_pk` via BLAKE2b. Because `ephemeral_pk` is fresh per call, the
  nonce is unique per call without ever being stored anywhere explicitly.
- The recipient reproduces the nonce on the way back: it has `recipient_pk`
  (its own key) and reads `ephemeral_pk` from the front of the blob.

So the single base64 blob in `ciphertextForRecipient` (or
`ciphertextForSender`) already contains everything `crypto_box_seal_open`
needs: the ephemeral public key, and the authenticated ciphertext under
the derived nonce. A separate column would be storing data the cipher
itself has already embedded — pure duplication, with the added risk of the
two getting out of sync.

This is also why we tag every row with `algorithm =
"x25519-xsalsa20poly1305-sealedbox"`: if we ever move to a scheme where a
nonce is *not* embedded (for example, a future ratcheted protocol), the
schema can evolve while old rows remain unambiguously decryptable under
the old algorithm.

## Checking that messages are encrypted in the database

The simplest demo is to send a few messages from the UI, then read the raw
`Message` rows out of Postgres. The plaintext should be nowhere to be found.

### Option A — psql

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

You will see rows like:

```
            id              |  senderId   | recipientId |               algorithm                |         recip_ct_head            |         send_ct_head             |          createdAt
----------------------------+-------------+-------------+----------------------------------------+----------------------------------+----------------------------------+-------------------------------
 cmsg_01jbq...              | ckxyz...    | ckabc...    | x25519-xsalsa20poly1305-sealedbox      | 7XQ2dM... (base64)               | 0lP+8a... (base64)               | 2026-05-19 10:01:23.456+00
```

The two ciphertext columns are opaque base64. There is no plaintext column
to look at, because there is no plaintext column at all.

### Option B — Prisma Studio

```bash
docker compose exec backend-1 npx prisma studio
```

Open the `Message` table in the browser. The two ciphertext columns will
render as long base64 strings.

### Option C — Quick "grep for plaintext" sanity check

Send a unique sentinel string like `the-cake-is-a-lie-2026` from the UI,
then look for it inside the dumped rows:

```bash
docker compose exec postgres-primary \
  pg_dump -U chat -d chat --data-only --table='"Message"' \
  | grep -i 'the-cake-is-a-lie-2026' \
  || echo 'sentinel not found in any column — server stored only ciphertext'
```

The expected output is `sentinel not found in any column — server stored
only ciphertext`. This is the strongest informal demonstration of the
end-to-end property: a string the user typed in the browser does not appear
anywhere in the database dump.
