/** @type {import('next').NextConfig} */

// Content-Security-Policy is set dynamically per-request in middleware.ts with a
// per-request nonce (so Next.js 16 / Turbopack inline hydration scripts are covered).
// The other security headers below are static and safe to set globally.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // HSTS: only honored over HTTPS; ignored on http://localhost in dev.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "publickey-credentials-get=(self), camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig = {
  // The SDK's resolveStorageAdapter() dynamically imports these optional backends.
  // Externalize them so the bundler resolves them at runtime (only the configured
  // one is ever loaded; the demo defaults to the in-memory store).
  serverExternalPackages: ["ioredis", "@vercel/kv", "@upstash/redis"],

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
