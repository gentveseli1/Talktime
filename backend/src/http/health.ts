import { Router } from 'express';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { pingRedis } from '../lib/redis.js';

export function healthRouter(redisClient: Redis): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const [dbOk, redisOk] = await Promise.all([
      prisma
        .$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      pingRedis(redisClient),
    ]);

    res.json({
      nodeId: env.NODE_ID,
      uptime: process.uptime(),
      db: dbOk ? 'ok' : 'down',
      redis: redisOk ? 'ok' : 'down',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
