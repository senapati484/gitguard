/**
 * app/api/auth/callback/github/route.ts
 *
 * Handler for GitHub App OAuth callback during installation.
 * When "Request user authorization (OAuth) during installation" is enabled,
 * GitHub redirects here with installation_id and code query parameters.
 * Delegates to /api/setup to register the installation and adminUids in Firestore.
 */
export { GET } from "@/app/api/setup/route";
