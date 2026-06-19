import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "TTC Login SDK — Demo",
  description:
    "Three ways to sign in: email & passkey, crypto wallet, or biometric. Your wallet is created and encrypted on your device.",
};

// CSP is applied per-request by proxy.ts (nonce-based). Next.js reads the nonce
// from the Content-Security-Policy *request* header at render time and stamps it
// onto every <script> tag it emits (inline hydration scripts + chunk loaders).
//
// That injection only happens when the route is rendered per-request. Without
// this, the pages have no dynamic data, so they're statically prerendered at
// build time (and CDN-cached), the per-request nonce never reaches the HTML, and
// every script is blocked by 'strict-dynamic'. force-dynamic opts all routes
// under this layout into dynamic rendering so the nonce is always applied.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
