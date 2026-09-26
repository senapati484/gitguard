/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["bullmq", "ioredis"],
  },
};

export default nextConfig;
