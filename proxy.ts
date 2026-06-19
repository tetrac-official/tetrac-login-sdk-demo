import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  // In dev, Turbopack injects inline HMR scripts that don't carry nonces.
  // 'unsafe-inline' is present so dev works; browsers that honour 'strict-dynamic'
  // (all modern) ignore 'unsafe-inline' in production, so it costs nothing there.
  const scriptSrc =
    process.env.NODE_ENV === "development"
      ? `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline'`
      : `'self' 'nonce-${nonce}' 'strict-dynamic'`;

  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // 'self' covers ws:// / wss:// on the same origin (Turbopack HMR WebSocket).
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  // Next.js extracts the nonce from the Content-Security-Policy *request* header
  // at render time and applies it to every <script> it emits (see app-render's
  // getScriptNonceFromHeader). x-nonce is also forwarded so server components can
  // read it via headers() if they need to tag their own inline scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("content-security-policy", csp);
  return response;
}

// Run on all page routes; skip static assets and API routes (no HTML → no CSP).
export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
