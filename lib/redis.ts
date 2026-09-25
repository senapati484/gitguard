/**
 * lib/redis.ts
 *
 * ioredis connection singleton — shared by the BullMQ Queue (enqueue side in
 * Next.js route handlers) and the Worker (separate Railway process).
 *
 * Upstash Redis requires:
 *   UPSTASH_REDIS_URL=rediss://default:<token>@<host>:<port>
 *
 * BullMQ requires:
 *   - maxRetriesPerRequest: null  (lets BullMQ manage retries itself)
 *   - enableOfflineQueue: false   (fail fast if Redis is unreachable at boot)
 */
import IORedis from "ioredis";

function buildConnection(): IORedis {
  const url = process.env.UPSTASH_REDIS_URL;
  if (!url) {
    throw new Error(
      "[redis] UPSTASH_REDIS_URL is not set. " +
        "Copy it from your Upstash console → Redis → REST API → ioredis URL."
    );
  }

  return new IORedis(url, {
    // Required by BullMQ — it handles its own retry logic per job
    maxRetriesPerRequest: null,
    // Don't queue commands when Redis is down; surface errors immediately
    enableOfflineQueue: false,
    // Batch commands automatically to reduce RTT on Upstash
    enableAutoPipelining: true,
    // Upstash uses TLS (rediss://); set rejectUnauthorized: false for dev
    tls: url.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
    // Exponential back-off, cap at 10 s, give up after 10 attempts
    retryStrategy(times) {
      if (times > 10) return null; // stop retrying → emit error event
      return Math.min(times * 200, 10_000);
    },
  });
}

// Module-level singleton so a single connection is reused across hot-reloads
// in dev and across handler invocations in the same worker process.
let _connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!_connection) {
    _connection = buildConnection();
  }
  return _connection;
}
