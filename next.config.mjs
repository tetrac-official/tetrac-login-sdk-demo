/** @type {import('next').NextConfig} */
const nextConfig = {
  // The SDK's resolveStorageAdapter() dynamically imports these optional backends.
  // Externalize them so the bundler resolves them at runtime (only the configured
  // one is ever loaded; the demo defaults to the in-memory store).
  serverExternalPackages: ["ioredis", "@vercel/kv", "@upstash/redis"],
};

export default nextConfig;
