import { prisma } from '../lib/prisma.js';

export type PersistMessageInput = {
  senderId: string;
  recipientId: string;
  ciphertextForRecipient: string;
  ciphertextForSender: string;
};

export async function persistMessage(input: PersistMessageInput) {
  return prisma.message.create({
    data: {
      senderId: input.senderId,
      recipientId: input.recipientId,
      ciphertextForRecipient: input.ciphertextForRecipient,
      ciphertextForSender: input.ciphertextForSender,
    },
    select: {
      id: true,
      senderId: true,
      recipientId: true,
      ciphertextForRecipient: true,
      ciphertextForSender: true,
      algorithm: true,
      createdAt: true,
    },
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
    select: {
      id: true,
      senderId: true,
      recipientId: true,
      ciphertextForRecipient: true,
      ciphertextForSender: true,
      algorithm: true,
      createdAt: true,
    },
  });
}
