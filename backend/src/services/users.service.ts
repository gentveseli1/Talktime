import { prisma } from '../lib/prisma.js';

export async function getPublicKey(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, publicKey: true },
  });
}
