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

/**
 * Exchanges the GitHub App JWT for a scoped installation access token and
 * returns an {@link Octokit} client authenticated as that installation.
 *
 * The token is cached internally by `@octokit/app` and refreshed before
 * expiry, so you can safely call this helper on every request.
 *
 * @param installationId - The numeric installation ID from the webhook
 *   payload (`payload.installation.id`).
 * @returns A promise resolving to an Octokit REST client scoped to the
 *   given installation's repositories and permissions.
 *
 * @throws If `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY` are not set.
 * @throws If GitHub rejects the JWT (wrong App ID or expired/invalid key).
 *
 * @example
 * // Inside a webhook handler (after signature verification):
 * const installationId = payload.installation.id;
 * const octokit = await getInstallationOctokit(installationId);
 *
 * await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
 *   owner: "acme",
 *   repo: "my-repo",
 *   name: "GitGuard",
 *   head_sha: payload.after,
 *   status: "in_progress",
 * });
 */
export async function getInstallationOctokit(
  installationId: number
): Promise<Octokit> {
  const app = getApp();
  return app.getInstallationOctokit(installationId);
}
