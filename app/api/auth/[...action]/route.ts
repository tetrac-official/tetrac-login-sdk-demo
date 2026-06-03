// One catch-all route serves every SDK endpoint:
//   POST challenge | register | login | login-wallet | import-wallet
//   GET  user-data | search-wallet
import { createNextAuthRoutes } from "@tetrac/login-sdk/next";
import { storage } from "../../../lib/storage";

export const runtime = "nodejs";

export const { GET, POST } = createNextAuthRoutes({
  storage,
  config: { webauthn: { rpName: "TTC Login Demo" } },
});
