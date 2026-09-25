/**
 * lib/redis.ts
 *
 * Upstash Redis client — used for rate limiting, caching, and job queues.
 *
 * Install: npm install @upstash/redis
 */

// import { Redis } from "@upstash/redis";

/**
 * Returns a singleton Upstash Redis client.
 * Uses REST-based HTTP calls (works in Edge Runtime and Node.js).
 *
 * @example
 * const redis = getRedis();
 * await redis.set("key", "value", { ex: 60 });
 * const val = await redis.get<string>("key");
 */
export function getRedis() {
  const url = process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Missing required env vars: UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN"
    );
  }

  // TODO: Uncomment after installing @upstash/redis
  // return new Redis({ url, token });

  return { url }; // placeholder
}

/**
 * Simple rate-limiter helper using Redis INCR + EXPIRE.
 * Returns true if the request is within the limit, false if exceeded.
 *
 * @param key     - Unique key for the rate limit bucket (e.g., `rate:ip:${ip}`)
 * @param limit   - Max requests allowed per window
 * @param windowS - Window duration in seconds
 */
export async function checkRateLimit(
  _key: string,
  _limit: number,
  _windowS: number
): Promise<boolean> {
  // TODO: implement with getRedis() once SDK is installed
  throw new Error("TODO: implement checkRateLimit — install @upstash/redis first");
}
