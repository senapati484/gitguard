/** @type {import('next').NextConfig} */
const nextConfig = {
  // Tell Next.js not to bundle these Node.js packages through webpack —
  // they contain native bindings or are only used server-side in the worker.
  serverExternalPackages: ["bullmq", "ioredis"],
};

export default nextConfig;
