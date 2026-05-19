import { Server, type ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { Server as HttpServer } from 'node:http';
import { z } from 'zod';
import { env } from '../config/env.js';
import { socketAuth } from './auth.js';
import {
  persistMessage,
  markDelivered,
  markRead,
  type StatusUpdate,
} from '../services/messages.service.js';
import { trackConnect, trackDisconnect } from '../services/presence.service.js';

// Global room every authenticated socket joins on connect. We broadcast
// presence updates here so any logged-in client sees every other user's
// online/offline transitions, regardless of which backend node holds the
// emitting socket. The Redis Socket.IO adapter handles cross-node fan-out.
const PRESENCE_ROOM = 'presence';

type Deps = {
  httpServer: HttpServer;
  pubClient: Redis;
  subClient: Redis;
};

// Room name for a given user. A socket joins its own user room on connect
// so the server can address a user by id without tracking socket-to-user
// mapping itself. Combined with the Redis adapter, a `to(userRoom(x))`
// emit reaches user x regardless of which backend node holds their socket.
const userRoom = (userId: string) => `user:${userId}`;

const sendSchema = z.object({
  recipientId: z.string().min(1),
  // base64 sealed-box ciphertexts; loose upper bound to reject obvious junk.
  ciphertextForRecipient: z.string().min(1).max(64 * 1024),
  ciphertextForSender: z.string().min(1).max(64 * 1024),
});

const receiptSchema = z.object({
  messageId: z.string().min(1).max(64),
});

export function createSocketServer({ httpServer, pubClient, subClient }: Deps): Server {
  const options: Partial<ServerOptions> = {
    cors: { origin: env.CORS_ORIGIN, credentials: true },
  };

  const io = new Server(httpServer, options);

  // Redis adapter — events emitted on one node fan out to the others.
  // This is what makes the backend horizontally scalable while keeping it stateless.
  io.adapter(createAdapter(pubClient, subClient));

  io.use(socketAuth);

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string;
    socket.join(userRoom(userId));
    socket.join(PRESENCE_ROOM);

    // Presence: increment the shared Redis counter. If this is the user's
    // first active socket across all backend nodes, broadcast that they
    // are now online. Concurrent connects on different nodes are safe
    // because HINCRBY is atomic.
    void (async () => {
      try {
        const cameOnline = await trackConnect(pubClient, userId);
        if (cameOnline) {
          io.to(PRESENCE_ROOM).emit('presence:update', {
            userId,
            online: true,
            lastSeenAt: null,
          });
        }
      } catch {
        // Presence is best-effort; an error here must not block chat.
      }
    })();

    socket.on('disconnect', () => {
      void (async () => {
        try {
          const lastSeenAt = await trackDisconnect(pubClient, userId);
          if (lastSeenAt !== null) {
            io.to(PRESENCE_ROOM).emit('presence:update', {
              userId,
              online: false,
              lastSeenAt,
            });
          }
        } catch {
          // ignore
        }
      })();
    });

    // v1 round-trip event — confirms which node handled the connection.
    socket.on('ping', (cb?: (payload: { nodeId: string; userId: string }) => void) => {
      if (typeof cb === 'function') {
        cb({ nodeId: env.NODE_ID, userId });
      }
      socket.emit('pong', { nodeId: env.NODE_ID, userId });
    });

    // Phase 2: send an encrypted direct message.
    // The server never sees plaintext. It persists both sealed-box copies
    // (for recipient and for sender) and forwards the appropriate ciphertext
    // to each side via per-user rooms. The Redis adapter ensures delivery
    // even when sender and recipient are connected to different backend
    // nodes.
    socket.on('message:send', async (raw: unknown, ack?: (res: unknown) => void) => {
      const parsed = sendSchema.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const { recipientId, ciphertextForRecipient, ciphertextForSender } = parsed.data;

      if (recipientId === userId) {
        ack?.({ ok: false, error: 'cannot_message_self' });
        return;
      }

      try {
        const stored = await persistMessage({
          senderId: userId,
          recipientId,
          ciphertextForRecipient,
          ciphertextForSender,
        });

        // Deliver to the recipient with the recipient-readable ciphertext.
        io.to(userRoom(recipientId)).emit('message:new', {
          id: stored.id,
          senderId: stored.senderId,
          recipientId: stored.recipientId,
          ciphertext: stored.ciphertextForRecipient,
          algorithm: stored.algorithm,
          createdAt: stored.createdAt,
          deliveredAt: stored.deliveredAt,
          readAt: stored.readAt,
        });

        // Confirm to the sender with the sender-readable ciphertext, so any
        // other tabs / devices that are signed in as the sender can render
        // the message immediately without refetching history.
        io.to(userRoom(userId)).emit('message:new', {
          id: stored.id,
          senderId: stored.senderId,
          recipientId: stored.recipientId,
          ciphertext: stored.ciphertextForSender,
          algorithm: stored.algorithm,
          createdAt: stored.createdAt,
          deliveredAt: stored.deliveredAt,
          readAt: stored.readAt,
        });

        ack?.({ ok: true, id: stored.id, createdAt: stored.createdAt });
      } catch {
        ack?.({ ok: false, error: 'persist_failed' });
      }
    });

    // Phase 4: delivery receipts. Only the recipient of a message can mark
    // it delivered. The server publishes a `message:status` event to the
    // sender room so the sender's UI can transition Sent → Delivered.
    socket.on('message:delivered', async (raw: unknown, ack?: (res: unknown) => void) => {
      const parsed = receiptSchema.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }

      try {
        const updated = await markDelivered(parsed.data.messageId, userId);
        if (!updated) {
          ack?.({ ok: false, error: 'not_recipient_or_not_found' });
          return;
        }
        emitStatus(io, updated);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false, error: 'update_failed' });
      }
    });

    // Phase 4: read receipts. A read receipt implies delivery, so the
    // service backfills `deliveredAt` if it was null. Only the recipient
    // may mark a message read.
    socket.on('message:read', async (raw: unknown, ack?: (res: unknown) => void) => {
      const parsed = receiptSchema.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }

      try {
        const updated = await markRead(parsed.data.messageId, userId);
        if (!updated) {
          ack?.({ ok: false, error: 'not_recipient_or_not_found' });
          return;
        }
        emitStatus(io, updated);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false, error: 'update_failed' });
      }
    });
  });

  return io;
}

// Fan out a `message:status` update to both ends of the conversation so the
// sender sees the receipt transition immediately and the recipient's other
// sessions stay in sync.
function emitStatus(io: Server, update: StatusUpdate) {
  const payload = {
    messageId: update.id,
    deliveredAt: update.deliveredAt,
    readAt: update.readAt,
  };
  io.to(userRoom(update.senderId)).emit('message:status', payload);
  io.to(userRoom(update.recipientId)).emit('message:status', payload);
}
