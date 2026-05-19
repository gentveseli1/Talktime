import { Redis } from 'ioredis';
import { env } from '../config/env.js';

// The Socket.IO Redis adapter requires two distinct clients:
// one for publishing and one for subscribing. They must not be shared.
export function createRedisClients() {
  const pubClient = new Redis(env.REDIS_URL, { lazyConnect: false });
  const subClient = pubClient.duplicate();
  return { pubClient, subClient };
}

// Lightweight health probe used by /health.
export async function pingRedis(client: Redis): Promise<boolean> {
  try {
    const reply = await client.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}
