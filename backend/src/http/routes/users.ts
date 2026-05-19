import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

export const usersRouter = Router();

// List all users except the caller. Public keys are included so the client
// can immediately encrypt a message without a follow-up round-trip.
usersRouter.get('/', requireAuth, async (req, res) => {
  const me = req.userId!;
  const users = await prisma.user.findMany({
    where: { NOT: { id: me } },
    select: { id: true, username: true, publicKey: true },
    orderBy: { username: 'asc' },
  });
  res.json({ users });
});
