import type { Redis } from 'ioredis';

// Redis keys.
//   presence:counts        — HASH userId -> open socket count (across all
//                            backend nodes; HINCRBY is atomic so concurrent
//                            connects/disconnects on different nodes are
//                            safe).
//   presence:lastSeen:<id> — STRING ISO timestamp of the most recent
//                            disconnect that took the count to zero.
const COUNTS_KEY = 'presence:counts';
const lastSeenKey = (userId: string) => `presence:lastSeen:${userId}`;

export type PresenceSnapshot = {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
};

// Increment the socket count for a user. Returns `true` if this is the
// transition from 0 to 1 (i.e. the user has just come online), and the
// caller should broadcast a `presence:update`.
export async function trackConnect(redis: Redis, userId: string): Promise<boolean> {
  const newCount = await redis.hincrby(COUNTS_KEY, userId, 1);
  if (newCount === 1) {
    // Coming online — clear any stale lastSeen so /presence reports null.
    await redis.del(lastSeenKey(userId));
    return true;
  }
  return false;
}

// Decrement the socket count. Returns the ISO timestamp at which the user
// became offline if this disconnect took the count to zero, otherwise null.
// On a transition to offline the hash entry is removed (HDEL) and a
// per-user `lastSeenAt` is written. On any decrement that does not yet
// reach zero, nothing else changes.
export async function trackDisconnect(redis: Redis, userId: string): Promise<string | null> {
  const newCount = await redis.hincrby(COUNTS_KEY, userId, -1);
  if (newCount <= 0) {
    const lastSeenAt = new Date().toISOString();
    // Use a tiny pipeline so HDEL + SET happen back-to-back without a
    // round-trip in between.
    await redis
      .multi()
      .hdel(COUNTS_KEY, userId)
      .set(lastSeenKey(userId), lastSeenAt)
      .exec();
    return lastSeenAt;
  }
  return null;
}

// Read the current presence for a set of users in two round-trips:
// one HMGET for the counts, one MGET for the lastSeen timestamps.
// Returns one entry per requested userId, with online=false / lastSeenAt=null
// if the user has never been seen on this Redis.
export async function getPresenceFor(
  redis: Redis,
  userIds: string[],
): Promise<PresenceSnapshot[]> {
  if (userIds.length === 0) return [];

  const counts = await redis.hmget(COUNTS_KEY, ...userIds);
  const lastSeenKeys = userIds.map(lastSeenKey);
  const lastSeens = await redis.mget(...lastSeenKeys);

  return userIds.map((userId, i) => {
    const count = counts[i];
    const online = count !== null && Number(count) > 0;
    return {
      userId,
      online,
      lastSeenAt: online ? null : lastSeens[i] ?? null,
    };
  });
}

// Reset the entire presence hash. Used at backend boot to clear counts that
// may have leaked from a previous run (e.g. SIGKILL of a backend that left
// counts incremented). Per-user lastSeen timestamps are preserved.
//
// Note: this is *not* called in the current implementation because there
// are three backend nodes — one node clearing the shared hash would also
// clear counts owned by the other two. Boot-time reset is therefore left
// to the operator (`FLUSHDB` or `HDEL` after a full stack restart). The
// helper is exported in case a single-node deployment wants it.
export async function resetPresence(redis: Redis): Promise<void> {
  await redis.del(COUNTS_KEY);
}
