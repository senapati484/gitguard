/**
 * app/api/webhooks/route.ts
 *
 * Alias for /api/webhooks/github so webhooks succeed even if
 * configured as /api/webhooks in the GitHub App settings.
 */
export { POST, GET } from "./github/route";
