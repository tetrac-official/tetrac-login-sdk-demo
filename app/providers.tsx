"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@tetrac/login-sdk/react";
import { APP_ID } from "./lib/appConfig";

export function Providers({ children }: { children: ReactNode }) {
  return (
    // Point the SDK client at our catch-all API route. walletGen defaults to
    // funds + signing on both chains; override here to request fewer.
    //
    // autoLockMs: the SDK default is 15s; we relax it to 60s for the demo so the
    // signed-in UI doesn't reset mid-exploration. After the idle window the vault
    // locks (status → session_expired) and signing requires re-auth; reveal ALWAYS
    // re-authenticates regardless of the lock.
    <AuthProvider apiBaseUrl="/api/auth" config={{ appId: APP_ID, autoLockMs: 60_000 }}>
      {children}
    </AuthProvider>
  );
}
