import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "TTC Login SDK — Demo",
  description:
    "Three ways to sign in: email & passkey, crypto wallet, or biometric. Your wallet is created and encrypted on your device.",
};

// CSP is applied per-request by middleware.ts (nonce-based). Next.js App Router
// automatically reads the x-nonce request header middleware sets and applies it
// to its own inline script tags — no extra wiring needed here.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
