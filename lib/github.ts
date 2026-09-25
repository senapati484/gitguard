/**
 * lib/github.ts
 *
 * GitHub App client utilities — authentication and API helpers.
 * Uses @octokit/app for GitHub App auth and @octokit/rest for REST calls.
 *
 * Install: npm install @octokit/app @octokit/rest
 */

// import { App } from "@octokit/app";
// import { Octokit } from "@octokit/rest";

/**
 * Returns a GitHub App instance authenticated with the App's private key.
 * Call this once and re-use across requests.
 *
 * @example
 * const app = getGitHubApp();
 * const installation = await app.getInstallationOctokit(installationId);
 */
export function getGitHubApp() {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!appId || !privateKey) {
    throw new Error(
      "Missing required env vars: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY"
    );
  }

  // TODO: Uncomment after installing @octokit/app
  // return new App({ appId, privateKey });

  return { appId, privateKey }; // placeholder
}

/**
 * Returns an installation-scoped Octokit client for a given installation ID.
 * Use this for all API calls that operate on a user's repositories.
 *
 * @param installationId - GitHub App installation ID
 */
export async function getInstallationClient(_installationId: number) {
  // const app = getGitHubApp();
  // return app.getInstallationOctokit(installationId);
  throw new Error("TODO: implement getInstallationClient — install @octokit/app first");
}
