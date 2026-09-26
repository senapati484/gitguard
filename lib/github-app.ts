/**
 * lib/github-app.ts
 *
 * GitHub App authentication helpers.
 *
 * Provides two things:
 *   1. `getApp()` — a singleton {@link App} instance authenticated with the
 *      App's RSA private key and App ID (creates a short-lived JWT internally).
 *   2. `getInstallationOctokit(installationId)` — exchanges the App JWT for a
 *      scoped installation access token and returns a ready-to-use Octokit
 *      REST client.
 *
 * Singleton pattern: the App instance is created once per Node.js process
 * (not per request) so JWT generation overhead is minimised.
 *
 * @see https://github.com/octokit/app.js
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
 */
import { App } from "@octokit/app";
import type { Octokit } from "@octokit/core";
import { Agent, setGlobalDispatcher, fetch as undiciFetch } from "undici";

// ---------------------------------------------------------------------------
// Configure global fetch dispatcher with extended connection timeout (45s)
// to eliminate undici default 10s "Connect Timeout Error (attempted address: api.github.com:443, timeout: 10000ms)"
// ---------------------------------------------------------------------------
try {
  const globalAgent = new Agent({
    connect: {
      timeout: 45_000, // 45 seconds instead of 10s default
    },
    headersTimeout: 45_000,
    bodyTimeout: 45_000,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
  });
  setGlobalDispatcher(globalAgent);
  // Ensure globalThis.fetch uses custom agent with 45s timeout across the app
  globalThis.fetch = ((input: any, init?: any) => {
    return undiciFetch(input, {
      ...init,
      dispatcher: globalAgent,
    });
  }) as any;
} catch (e) {
  console.warn("[github-app] Could not set undici global dispatcher:", e);
}

/**
 * Executes an Octokit request with exponential backoff retries for transient
 * connection timeouts, network drops, or GitHub API gateway errors.
 */
export async function octokitRequestWithRetry<T>(
  requestFn: () => Promise<T>,
  retries = 3,
  delayMs = 1500
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await requestFn();
    } catch (err: any) {
      attempt++;
      const msg = err?.message || String(err);
      const isTransient =
        msg.includes("Connect Timeout Error") ||
        msg.includes("connect timeout") ||
        msg.includes("fetch failed") ||
        err?.code === "ECONNRESET" ||
        err?.code === "ETIMEDOUT" ||
        err?.code === "UND_ERR_CONNECT_TIMEOUT" ||
        err?.status === 500 ||
        err?.status === 502 ||
        err?.status === 503 ||
        err?.status === 504;

      if (!isTransient || attempt >= retries) {
        throw err;
      }

      const backoff = delayMs * Math.pow(2, attempt - 1);
      console.warn(
        `[octokit] Transient network issue (${msg}). Retrying in ${backoff}ms (attempt ${attempt}/${retries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton — created once, reused across all requests.
// ---------------------------------------------------------------------------
let _app: App | null = null;

/**
 * Reads and validates the required GitHub App environment variables.
 * Throws a descriptive error if any are missing so misconfiguration is caught
 * at startup rather than on the first webhook delivery.
 */
function readConfig(): { appId: string; privateKey: string } {
  const appId = process.env.GITHUB_APP_ID;
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId) {
    throw new Error(
      "[github-app] Missing env var: GITHUB_APP_ID. " +
        "Set it to the numeric GitHub App ID from your App's settings page."
    );
  }
  if (!rawKey) {
    throw new Error(
      "[github-app] Missing env var: GITHUB_APP_PRIVATE_KEY. " +
        "Paste the full PEM private key, replacing literal newlines with \\n."
    );
  }

  // GitHub's private key PEMs may be stored as a single line with `\n` escape
  // sequences (common in .env files and CI secrets). Restore real newlines.
  const privateKey = rawKey.replace(/\\n/g, "\n");

  return { appId, privateKey };
}

/**
 * Returns the singleton GitHub {@link App} instance.
 *
 * Initialises on first call; subsequent calls return the cached instance.
 * Safe to call at module level inside route handlers — no I/O on creation.
 *
 * @example
 * const app = getApp();
 * const octokit = await app.getInstallationOctokit(installationId);
 */
export function getApp(): App {
  if (_app) return _app;

  const { appId, privateKey } = readConfig();

  _app = new App({ appId, privateKey });

  return _app;
}

// ---------------------------------------------------------------------------
// Installation token cache: GitHub tokens are valid for 1 hour (3600s).
// We cache the authenticated Octokit instance for 55 minutes (with 5-minute safety buffer).
// ---------------------------------------------------------------------------
interface CachedOctokitEntry {
  octokit: Octokit;
  expiresAt: number;
}

const _installationTokenCache = new Map<number, CachedOctokitEntry>();

/**
 * Exchanges the GitHub App JWT for a scoped installation access token and
 * returns an {@link Octokit} client authenticated as that installation.
 *
 * Caches the installation token and Octokit instance for 55 minutes (~1h GitHub validity)
 * avoiding redundant JWT signing and access_tokens HTTP roundtrips.
 *
 * @param installationId - The numeric installation ID from the webhook payload.
 * @returns A promise resolving to an Octokit REST client.
 */
export async function getInstallationOctokit(
  installationId: number
): Promise<Octokit> {
  const result = await getInstallationOctokitWithMeta(installationId);
  return result.octokit;
}

/**
 * Returns the authenticated Octokit instance along with cache status metadata.
 */
export async function getInstallationOctokitWithMeta(
  installationId: number
): Promise<{ octokit: Octokit; cached: boolean }> {
  const now = Date.now();
  const cached = _installationTokenCache.get(installationId);

  // Return cached client if token has > 3 minutes remaining
  if (cached && cached.expiresAt > now + 3 * 60 * 1000) {
    return { octokit: cached.octokit, cached: true };
  }

  const app = getApp();
  const octokit = await app.getInstallationOctokit(installationId);

  // Cache for 55 minutes (~1 hour validity)
  _installationTokenCache.set(installationId, {
    octokit,
    expiresAt: now + 55 * 60 * 1000,
  });

  return { octokit, cached: false };
}

