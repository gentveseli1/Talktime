import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { healthRouter } from './health.js';
import { authRouter } from './routes/auth.js';
import { keysRouter } from './routes/keys.js';
import { usersRouter } from './routes/users.js';
import { messagesRouter } from './routes/messages.js';
import { presenceRouter } from './routes/presence.js';

export function createApp(redisClient: Redis) {
  const app = express();

  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(pinoHttp({ level: env.LOG_LEVEL }));

  app.use(healthRouter(redisClient));
  app.use('/auth', authRouter);
  app.use('/keys', keysRouter);
  app.use('/users', usersRouter);
  app.use('/messages', messagesRouter);
  app.use('/presence', presenceRouter(redisClient));

  return app;
}
