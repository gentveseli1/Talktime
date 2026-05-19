import http from 'node:http';
import pino from 'pino';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { createRedisClients } from './lib/redis.js';
import { createApp } from './http/app.js';
import { createSocketServer } from './socket/server.js';

const log = pino({ level: env.LOG_LEVEL, base: { nodeId: env.NODE_ID } });

async function main() {
  // 1. Prisma — verify connectivity early so the node refuses to start without a DB.
  await prisma.$connect();
  log.info('prisma connected');

  // 2. Redis pub/sub clients for the Socket.IO adapter.
  const { pubClient, subClient } = createRedisClients();
  log.info('redis clients created');

  // 3. Express + HTTP server.
  const app = createApp(pubClient);
  const httpServer = http.createServer(app);

  // 4. Socket.IO + Redis adapter.
  createSocketServer({ httpServer, pubClient, subClient });
  log.info('socket.io ready');

  // 5. Start listening.
  httpServer.listen(env.PORT, () => {
    log.info(`node ${env.NODE_ID} listening on :${env.PORT}`);
  });

  // 6. Graceful shutdown.
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    httpServer.close();
    await Promise.allSettled([
      prisma.$disconnect(),
      pubClient.quit(),
      subClient.quit(),
    ]);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ err }, 'fatal startup error');
  process.exit(1);
});
