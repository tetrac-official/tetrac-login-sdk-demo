// One catch-all route serves every SDK endpoint:
//   POST challenge | register | login | login-wallet | connect-wallet | import-wallet | logout
//   GET  user-data | search-wallet   (search-wallet is IP rate-limited)
import { createNextAuthRoutes } from "@tetrac/login-sdk/next";
import { storage } from "../../../lib/storage";

export const runtime = "nodejs";

export const { GET, POST } = createNextAuthRoutes({
  storage,
  config: {
    webauthn: { rpName: "TTC Login Demo" },
    // Vercel sets x-forwarded-for from its own edge — trust it there so rate
    // limiting is per-visitor. Local dev has no proxy: leave untrusted.
    trustProxyHeaders: !!process.env.VERCEL,
  },
});
