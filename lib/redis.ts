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

function attachErrorHandler(client: IORedis): IORedis {
  client.on("error", (err: Error & { code?: string; errno?: number }) => {
    const msg = err?.message || String(err);
    const code = err?.code || "";
    if (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      err?.errno === -54 ||
      err?.errno === -60 ||
      msg.includes("ECONNRESET") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("Stream isn't writeable")
    ) {
      // Expected when Upstash closes idle serverless sockets; ioredis reconnects on demand
      return;
    }
    console.warn("[redis] Connection notice:", msg);
  });

  // Ensure any duplicate connection spawned by BullMQ also inherits this error handler
  const origDuplicate = client.duplicate.bind(client);
  client.duplicate = function (...args: unknown[]) {
    const dup = (origDuplicate as (...params: unknown[]) => IORedis)(...args);
    return attachErrorHandler(dup);
  };

  return client;
}

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

  return attachErrorHandler(client);
}

// Global process-level handler to prevent idle Upstash serverless socket drops
// from logging unhandled stream read ETIMEDOUT / ECONNRESET in Next.js dev server.
const globalState = globalThis as unknown as {
  __gitguard_redis_error_hooked?: boolean;
};

if (typeof process !== "undefined" && !globalState.__gitguard_redis_error_hooked) {
  globalState.__gitguard_redis_error_hooked = true;
  process.on("uncaughtException", (err: unknown) => {
    const errObj = (typeof err === "object" && err !== null ? err : {}) as {
      code?: string;
      errno?: number;
      message?: string;
    };
    const code = errObj.code;
    const errno = errObj.errno;
    const msg = err instanceof Error ? err.message : errObj.message || "";
    if (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      errno === -54 ||
      errno === -60 ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("ECONNRESET")
    ) {
      return; // Ignore idle socket termination from serverless Redis
    }
    console.error("Uncaught exception:", err);
  });
}

// Preserve connection across Next.js HMR reloads so orphan sockets don't linger
const globalForRedis = globalThis as unknown as {
  __gitguard_redis_conn?: IORedis;
};

export function getRedisConnection(): IORedis {
  if (!globalForRedis.__gitguard_redis_conn) {
    globalForRedis.__gitguard_redis_conn = buildConnection();
  }
  return globalForRedis.__gitguard_redis_conn;
}
