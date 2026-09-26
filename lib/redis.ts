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
  let url = process.env.UPSTASH_REDIS_URL;
  if (!url) {
    throw new Error(
      "[redis] UPSTASH_REDIS_URL is not set. " +
        "Copy it from your Upstash console → Redis → Details → ioredis URL (rediss://...)."
    );
  }

  // If the user provided the REST URL (https://) instead of the ioredis URI (rediss://)
  if (url.startsWith("https://")) {
    const host = url.replace("https://", "").replace(/\/$/, "");
    const token = process.env.UPSTASH_REDIS_TOKEN || "";
    if (token) {
      url = `rediss://default:${token}@${host}:6379`;
    }
  }

  const client = new IORedis(url, {
    // Required by BullMQ — it handles its own retry logic per job
    maxRetriesPerRequest: null,
    // Don't queue commands when Redis is down; surface errors immediately
    enableOfflineQueue: false,
    // TCP keep-alive prevents Upstash serverless from dropping idle connections
    keepAlive: 10_000,
    connectTimeout: 20_000,
    family: 4,
    // Upstash uses TLS (rediss://); set rejectUnauthorized: false for dev
    tls: url.startsWith("rediss://") ? { rejectUnauthorized: false } : undefined,
    // Exponential back-off, cap at 5s, retry up to 20 attempts
    retryStrategy(times) {
      if (times > 20) return null;
      return Math.min(times * 300, 5_000);
    },
  });

  // Handle idle connection drops from Upstash serverless gracefully
  client.on("error", (err: Error & { code?: string }) => {
    const msg = err?.message || String(err);
    const code = err?.code || "";
    if (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      msg.includes("ECONNRESET") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("Stream isn't writeable")
    ) {
      // Expected on idle cloud Redis drops; ioredis reconnects automatically via retryStrategy
      return;
    }
    console.warn("[redis] Connection notice:", msg);
  });

  return client;
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
