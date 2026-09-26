/** @type {import('next').NextConfig} */
const nextConfig = {
  // In Next.js 14 App Router, external packages belong under experimental.serverComponentsExternalPackages
  experimental: {
    serverComponentsExternalPackages: ["bullmq", "ioredis"],
  },
};

export default nextConfig;
