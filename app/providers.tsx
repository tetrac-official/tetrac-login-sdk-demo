"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@tetrac/login-sdk/react";

export function Providers({ children }: { children: ReactNode }) {
  return (
    // Point the SDK client at our catch-all API route. walletGen defaults to
    // funds + signing on both chains; override here to request fewer.
    <AuthProvider apiBaseUrl="/api/auth">{children}</AuthProvider>
  );
}
