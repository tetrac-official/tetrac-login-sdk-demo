import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// next-ttc-login and tetrac-login-sdk are siblings under /Users/mac/Documents/TTC.
// We need Turbopack's filesystem root to cover both, otherwise it refuses to
// follow the file:-link symlink at node_modules/@tetrac/login-sdk → ../../../tetrac-login-sdk
// with "Symlink ... is invalid, it points out of the filesystem root".
const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(here, "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The SDK's resolveStorageAdapter() dynamically imports these optional backends.
  // Externalize them so the bundler resolves them at runtime (only the configured
  // one is ever loaded; the demo defaults to the in-memory store).
  serverExternalPackages: ["ioredis", "@vercel/kv", "@upstash/redis"],
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
