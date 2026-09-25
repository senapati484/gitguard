/**
 * app/api/github/setup/route.ts
 *
 * Alias for /api/setup to support GitHub App setups configured with
 * /api/github/setup as their post-installation Setup URL.
 */
export { GET } from "@/app/api/setup/route";
