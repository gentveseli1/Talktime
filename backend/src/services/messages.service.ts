import { prisma } from '../lib/prisma.js';

export type PersistMessageInput = {
  senderId: string;
  recipientId: string;
  ciphertextForRecipient: string;
  ciphertextForSender: string;
};

// Fields returned to the client. Includes the two ciphertext copies plus the
// delivery/read receipt timestamps. Receipts are nullable until the recipient
// transitions them.
const messageFields = {
  id: true,
  senderId: true,
  recipientId: true,
  ciphertextForRecipient: true,
  ciphertextForSender: true,
  algorithm: true,
  createdAt: true,
  deliveredAt: true,
  readAt: true,
} as const;

export async function persistMessage(input: PersistMessageInput) {
  return prisma.message.create({
    data: {
      senderId: input.senderId,
      recipientId: input.recipientId,
      ciphertextForRecipient: input.ciphertextForRecipient,
      ciphertextForSender: input.ciphertextForSender,
    },
    select: messageFields,
  });
}

// All messages exchanged between two users, oldest first.
export async function getConversation(userA: string, userB: string, limit = 200) {
  return prisma.message.findMany({
    where: {
      OR: [
        { senderId: userA, recipientId: userB },
        { senderId: userB, recipientId: userA },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: messageFields,
  });
}

export type StatusUpdate = {
  id: string;
  senderId: string;
  recipientId: string;
  deliveredAt: Date | null;
  readAt: Date | null;
};

// Mark a message as delivered. Only the recipient may do this. Idempotent:
// if `deliveredAt` is already set, the existing timestamp is preserved.
// Returns the updated row, or `null` if the message does not exist or the
// caller is not the recipient.
export async function markDelivered(
  messageId: string,
  recipientId: string,
): Promise<StatusUpdate | null> {
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, senderId: true, recipientId: true, deliveredAt: true, readAt: true },
  });
  if (!msg || msg.recipientId !== recipientId) return null;

  if (msg.deliveredAt !== null) {
    return {
      id: msg.id,
      senderId: msg.senderId,
      recipientId: msg.recipientId,
      deliveredAt: msg.deliveredAt,
      readAt: msg.readAt,
    };
  }

  const updated = await prisma.message.update({
    where: { id: messageId },
    data: { deliveredAt: new Date() },
    select: { id: true, senderId: true, recipientId: true, deliveredAt: true, readAt: true },
  });
  return updated;
}

// Mark a message as read. Only the recipient may do this. If `deliveredAt`
// has not yet been set, it is set to the same timestamp as `readAt` (a read
// receipt implies delivery). `readAt` is preserved if already set.
export async function markRead(
  messageId: string,
  recipientId: string,
): Promise<StatusUpdate | null> {
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, senderId: true, recipientId: true, deliveredAt: true, readAt: true },
  });
  if (!msg || msg.recipientId !== recipientId) return null;

  if (msg.readAt !== null) return msg;

  const now = new Date();
  const updated = await prisma.message.update({
    where: { id: messageId },
    data: {
      readAt: now,
      deliveredAt: msg.deliveredAt ?? now,
    },
    select: { id: true, senderId: true, recipientId: true, deliveredAt: true, readAt: true },
  });
  return updated;
}
