// One catch-all route serves every SDK endpoint:
//   POST challenge | register | login | login-wallet | connect-wallet | import-wallet | logout
//   GET  user-data | search-wallet   (search-wallet is IP rate-limited)
import { createNextAuthRoutes } from "@tetrac/login-sdk/next";
import { storage } from "../../../lib/storage";
import { APP_ID } from "../../../lib/appConfig";

export const runtime = "nodejs";

export const { GET, POST } = createNextAuthRoutes({
  storage,
  config: {
    // Multi-app storage namespace (v0.4.0). The client already sends this appId on
    // every request; setting it here too makes the server's fallback match instead
    // of defaulting to "ttc", so APP_ID is the single source of truth and a request
    // that ever omits appId still lands in this app's namespace, not a stray one.
    // For a shared Upstash DB, also set `allowedAppIds: [APP_ID]` to reject others.
    appId: APP_ID,
    webauthn: { rpName: "TTC Login Demo" },
    // Vercel sets x-forwarded-for from its own edge — trust it there so rate
    // limiting is per-visitor. Local dev has no proxy: leave untrusted.
    trustProxyHeaders: !!process.env.VERCEL,
    // Rightmost XFF hop after 0 trusted proxies (Vercel single-edge default).
    trustedProxyHops: 0,
    // OWASP-2023 minimum: 600k PBKDF2 iterations. Pinned per-user on register.
    securityLevel: 2,
  },
});
