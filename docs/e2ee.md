# Educational End-to-End Encryption

This document describes the encryption scheme used by this project and is
intentionally honest about what it does **not** provide. The scheme is chosen
to be simple enough to explain in a thesis defense while still keeping the
server out of plaintext.

## Scheme

- Library: [`libsodium-wrappers`](https://github.com/jedisct1/libsodium.js)
- Algorithm: **libsodium sealed boxes**
  (`crypto_box_seal` / `crypto_box_seal_open`)
- Primitives: X25519 (key exchange) + XSalsa20 (cipher) + Poly1305 (MAC)
- Stored on disk (Postgres) as base64 ciphertext with an `algorithm` column of
  `x25519-xsalsa20poly1305-sealedbox`.

### Key lifecycle

1. The client calls `crypto_box_keypair()` at registration. This produces a
   32-byte X25519 public key and a 32-byte private key.
2. The **public key** is sent to the server in the `POST /auth/register` body
   and persisted in the `User.publicKey` column.
3. The **private key** is stored locally in the browser's IndexedDB
   (`chat-e2ee` → `keys` object store) under the user's id. It never crosses
   the network.

### Sending a message (phase 2)

1. Sender fetches the recipient's public key from `GET /keys/:userId`.
2. Sender calls `crypto_box_seal(plaintext, recipientPublicKey)`. This:
   - Generates an ephemeral X25519 keypair just for this message.
   - Derives a shared secret with the recipient's public key.
   - Encrypts + authenticates the plaintext under that shared secret.
   - Returns a ciphertext blob that embeds the ephemeral public key and a
     nonce. **No separate nonce field is needed.**
3. Sender base64-encodes the ciphertext and sends it to the server.
4. Server stores `{ senderId, recipientId, ciphertext, algorithm }` and
   forwards the ciphertext to the recipient via Socket.IO (Redis adapter
   handles cross-node fan-out).

### Receiving a message (phase 2)

1. Recipient receives the base64 ciphertext.
2. Recipient calls
   `crypto_box_seal_open(ciphertext, recipientPublicKey, recipientPrivateKey)`.
3. Decryption fails (returns null / throws) if the MAC does not verify.

## What the server can and cannot see

| Can see                          | Cannot see                       |
|----------------------------------|----------------------------------|
| Sender id                        | Plaintext message content        |
| Recipient id                     | Sender's identity *from the ciphertext alone* (the ephemeral key in a sealed box does not identify the sender — but the `senderId` column does, of course) |
| Timestamp                        |                                  |
| Ciphertext length (a metadata leak) |                               |
| Public keys of all users         | Any private key                  |

## What this scheme does NOT provide

This is the most important section. Be ready to explain these in a thesis Q&A:

- **No forward secrecy.** If a user's private key is ever compromised,
  every message ever sent to that user can be decrypted. The Signal Protocol's
  double ratchet would solve this; we explicitly do not implement it.
- **No deniability.** Combined with the `senderId` column, there is a strong
  audit trail of who sent what (the *content* is unknown to the server, but
  the *fact of a message* is fully visible).
- **No multi-device support.** The private key lives in one browser's
  IndexedDB. Logging in on a second device cannot decrypt old messages and
  cannot generate the same keypair. A real product would solve this with
  encrypted key backup, device linking, or a key transparency log.
- **Lose the private key, lose the history.** Clearing browser storage,
  using a different browser, or switching devices is permanent. There is no
  recovery flow in v1.
- **No protection against a malicious server substituting public keys.**
  The server returns whatever public key it stored for a given user. A
  compromised server could swap a user's public key and read subsequent
  messages. A real product would mitigate this with safety numbers,
  out-of-band key verification, or key transparency.
- **No group chat.** v1 is 1:1 only. Group chat with sealed boxes would
  require encrypting once per recipient.

## Why this is appropriate for a university final project

The project's primary contribution is the **distributed systems** story
(3 nodes, Nginx failover, Redis-coordinated Socket.IO, encrypted replicated
history). The E2EE component exists to demonstrate that the server is kept
out of plaintext — a property the simple sealed-box scheme achieves
cleanly. Adopting Signal-style ratcheting would multiply implementation
complexity without changing the distributed-systems story, and would risk
the thesis becoming a cryptography project instead of a distributed-systems
project.

The scope is documented honestly in the README and here; that honesty is
itself a thesis-friendly stance.
