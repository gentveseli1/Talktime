import { Router } from 'express';
import type { Redis } from 'ioredis';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { getPresenceFor } from '../../services/presence.service.js';

// GET /presence
//
// Returns the current presence snapshot for every user the caller is allowed
// to see — for the v1 1:1-DM-only scope that means "every user other than
// the caller". The shape matches what the Socket.IO `presence:update` event
// publishes, so the client can fold the snapshot and the live stream into
// the same local state without normalising.
export function presenceRouter(redis: Redis): Router {
  const router = Router();

  router.get('/', requireAuth, async (req, res) => {
    const me = req.userId!;
    const users = await prisma.user.findMany({
      where: { NOT: { id: me } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    const presence = await getPresenceFor(redis, ids);
    res.json({ presence });
  });

  return router;
}
