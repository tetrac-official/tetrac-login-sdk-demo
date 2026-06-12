# Skill: Integrate @tetrac/login-sdk into a Next.js App Router project

## When to use this skill

Use this skill when a user asks to:

- Add `@tetrac/login-sdk` to a new or existing Next.js project
- Set up email/passkey, Web3 wallet, or biometric login
- Wire up the SDK's auth routes, storage adapter, and React provider
- Understand the complete integration checklist for the SDK

---

## Overview

`@tetrac/login-sdk` is a non-custodial authentication SDK. It handles:

- Key derivation (PBKDF2 / WebAuthn PRF / wallet signature)
- Wallet generation and AES-256-GCM encryption in the browser
- Server-side challenge/sign/verify auth (ed25519)
- Session management, rate-limiting, and storage

The integration spans **four files** and one shared constant. Do them in this order.

---

## Step 1 — Install

```bash
npm install @tetrac/login-sdk
# Peer deps for storage backends (only the configured one loads at runtime):
npm install ioredis @vercel/kv @upstash/redis
# Chain libs the client side needs:
npm install @solana/web3.js viem tweetnacl
```

Clear `.next` after install if Turbopack caches the old module graph:

```bash
rm -rf .next
```

---

## Step 2 — Shared app config (`app/lib/appConfig.ts`)

Create this file **first**. The `appId` domain-separates key derivation — every
SDK call that touches key material must use the same value. Changing it after
first use orphans all existing encrypted wallets.

```ts
// app/lib/appConfig.ts
export const APP_ID = "your-app-name"; // unique, stable, never change after first deploy
```

> **Rule:** `APP_ID` must be unique per deployment. Using the default `"ttc"` gives
> no cross-app isolation and the SDK logs a warning. Set it to your product or domain.

---

## Step 3 — Storage adapter (`app/lib/storage.ts`)

The storage adapter is shared by all auth route handlers. Zero config uses
in-memory (single process only). Set env vars to auto-select a real backend.

```ts
// app/lib/storage.ts
import { MemoryAdapter, resolveStorageAdapter, type StorageAdapter } from "@tetrac/login-sdk/storage";

const useRealBackend =
  !!process.env.REDIS_URL ||
  !!process.env.VERCEL ||
  !!process.env.KV_REST_API_URL ||
  !!process.env.UPSTASH_REDIS_REST_URL;

// Top-level await works in Next.js server modules.
export const storage: StorageAdapter = useRealBackend ? await resolveStorageAdapter() : new MemoryAdapter();
```

> **Production rule:** `MemoryAdapter` is process-local — it does not work across
> serverless instances. Use Redis / Vercel KV / Upstash in production. The SDK
> throws at startup in `NODE_ENV=production` if no backend is configured.

---

## Step 4 — API route (`app/api/auth/[...action]/route.ts`)

One catch-all route handles every SDK endpoint:
`POST challenge | register | login | login-wallet | connect-wallet | import-wallet | logout`
`GET  user-data | search-wallet`

```ts
// app/api/auth/[...action]/route.ts
import { createNextAuthRoutes } from "@tetrac/login-sdk/next";
import { storage } from "../../../lib/storage";

export const runtime = "nodejs";

export const { GET, POST } = createNextAuthRoutes({
  storage,
  config: {
    webauthn: { rpName: "Your App Name" },
    // Trust x-forwarded-for only behind a proxy you control.
    // On Vercel, VERCEL env var is set automatically.
    trustProxyHeaders: !!process.env.VERCEL,
    trustedProxyHops: 0, // rightmost XFF hop = real visitor (Vercel/single-edge)
    securityLevel: 2, // 600k PBKDF2 iterations — OWASP-2023 minimum
  },
});
```

**`securityLevel` values:**

| Level | Iterations | Notes                                 |
| ----- | ---------- | ------------------------------------- |
| `1`   | 100 000    | Below OWASP — legacy / low-value only |
| `2`   | 600 000    | **Default. OWASP-2023 minimum.**      |
| `3`   | 1 000 000  | Maximum resistance, slower login      |

The resolved iteration count is pinned per-user in `UserData.pbkdf2Iterations` and
returned with the challenge, so it stays stable even if you change the config later.

---

## Step 5 — React Provider (`app/providers.tsx`)

Wrap the app in `<AuthProvider>`. Import `APP_ID` from the shared config — never
hardcode the string here so it stays in sync with direct SDK calls.

```tsx
// app/providers.tsx
"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@tetrac/login-sdk/react";
import { APP_ID } from "./lib/appConfig";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider
      apiBaseUrl="/api/auth"
      config={{
        appId: APP_ID,
        autoLockMs: 15_000, // idle vault lock — keep short in production
      }}
    >
      {children}
    </AuthProvider>
  );
}
```

Then add it to `app/layout.tsx`:

```tsx
// app/layout.tsx
import { Providers } from "./providers";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

---

## Step 6 — Content-Security-Policy (`proxy.ts` + `next.config.mjs`)

Next.js 16 / Turbopack injects inline scripts that a static `script-src 'self'`
blocks. Use a **nonce-based CSP via `proxy.ts`** (the Next.js 16 replacement for
`middleware.ts`) so the nonce is generated per-request and applied automatically
to the framework's own script tags.

```ts
// proxy.ts  (project root)
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

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
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

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
```

In `next.config.mjs`, **do not set a static CSP header** (proxy.ts owns it).
Do set the other security headers and externalize the storage backend packages:

```js
// next.config.mjs
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "publickey-credentials-get=(self), camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig = {
  // Externalize optional storage backends — only the configured one loads at runtime.
  serverExternalPackages: ["ioredis", "@vercel/kv", "@upstash/redis"],

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
```

---

## Step 7 — Using the hooks in a component

All three login methods share the same `useAuth()` hook. The component never
implements auth logic — that all comes from the SDK.

```tsx
"use client";

import { useAuth, useUser, useWallets, useSolanaSigner, useEvmSigner } from "@tetrac/login-sdk/react";
import { APP_ID } from "../lib/appConfig";
import { walletAppKeyMessage, deriveAppKeyFromPasskey } from "@tetrac/login-sdk/core";

export function AuthDemo() {
  const auth = useAuth();
  const { user } = useUser();

  // --- Email + passkey ---
  const register = () => auth.registerWithEmail({ email: "alice@example.com", passkey: "hunter2" });
  const login = () => auth.loginWithEmail({ email: "alice@example.com", passkey: "hunter2" });

  // --- Web3 wallet (Solana) ---
  const connectWallet = async () => {
    // Provide a signer object — real Phantom or simulated keypair.
    const signer = {
      publicKey: "...",
      signMessage: async (m: Uint8Array) => {
        /* sign */ return new Uint8Array();
      },
    };
    await auth.connectWallet(signer);
  };

  // --- Biometric ---
  const bioRegister = () => auth.registerWithBiometric({ userName: "alice" });
  const bioLogin = (registration: any) => auth.loginWithBiometric({ registration });

  // --- Logout ---
  const logout = () => auth.logout();

  return <div>{user ? `Signed in as ${user.email}` : "Not signed in"}</div>;
}
```

### Key derivation in manual re-auth ceremonies

If your app implements a manual "re-auth to reveal key" ceremony (deriving the
app key directly to decrypt a wallet), two things must match registration exactly:

```ts
// Wallet method re-auth:
// Pass APP_ID so the signed message matches registration ("App:your-app-name").
// Without it walletAppKeyMessage() defaults to "App:ttc" and the derived key
// won't decrypt the wallet.
const sig = await signer.signMessage(new TextEncoder().encode(walletAppKeyMessage(APP_ID)));
const key = deriveAppKeyFromSignature(toHex(sig));

// Email method re-auth:
// The third param is pbkdf2Iterations (number), NOT appId.
// Pass user.pbkdf2Iterations so the same iteration count is used as at registration.
// The default changes across securityLevel configs — always pin to the stored value.
const key = deriveAppKeyFromPasskey(passkey, user.email ?? "", user.pbkdf2Iterations);
```

### `AuthStatus` type

The SDK's `status` field from `useAuth()` has three values only:

```ts
type AuthStatus = "authenticated" | "session_expired" | "unauthenticated";
```

The **locked** state is a separate boolean: `auth.isLocked`. When the vault is
locked the `status` is still `"authenticated"` (the session token is valid) — only
the in-memory key is gone. Use `auth.isLocked` to gate signing, not `status`.

### `lockOnHide` and wallet signing popups

**Problem:** Wallet signing (Phantom / any injected provider) opens a browser
popup that briefly backgrounds the parent tab. With the default `lockOnHide: true`
the SDK fires a visibility-change lock _before the signature returns_, changing
`status` to `session_expired` and unmounting any reveal panel.

**Fix:** On any page that uses `ExportKeyPanel` or calls `walletSignMessage`
directly, instantiate `AuthProvider` with `lockOnHide: false` instead of the
shared `<Providers>` wrapper:

```tsx
// app/some-page/page.tsx
import { AuthProvider } from "@tetrac/login-sdk/react";
import { APP_ID } from "../lib/appConfig";

export default function SomePage() {
  return (
    // lockOnHide: false lets the Phantom popup open without expiring the session.
    <AuthProvider apiBaseUrl="/api/auth" config={{ appId: APP_ID, autoLockMs: 60_000, lockOnHide: false }}>
      <SomePageInner />
    </AuthProvider>
  );
}
```

Keep `lockOnHide: true` (the default) for pages that do **not** need wallet
signing — it limits the window a decrypted key sits in memory.

---

## Step 8 — Environment variables

Copy `.env.local.example` to `.env.local` and fill in **one** backend:

```bash
# Local Redis
REDIS_URL=redis://localhost:6379

# Vercel KV
KV_REST_API_URL=...
KV_REST_API_TOKEN=...

# Upstash Redis (edge-friendly REST)
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

Leave all blank for in-memory (dev only).

---

## File checklist

| File                                | Purpose                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| `app/lib/appConfig.ts`              | `APP_ID` constant — single source of truth                  |
| `app/lib/storage.ts`                | Storage adapter (memory → Redis/KV/Upstash)                 |
| `app/api/auth/[...action]/route.ts` | All SDK endpoints via `createNextAuthRoutes()`              |
| `app/providers.tsx`                 | `<AuthProvider>` wrapping the app                           |
| `app/layout.tsx`                    | Mounts `<Providers>`                                        |
| `proxy.ts`                          | Per-request nonce CSP (replaces static `script-src 'self'`) |
| `next.config.mjs`                   | Security headers + `serverExternalPackages`                 |

---

## Common mistakes

| Mistake                                                                                               | Symptom                                                                          | Fix                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appId` not set or set differently in `AuthProvider` vs direct `walletAppKeyMessage()` call           | Wallet re-auth decrypts to the wrong key; reveal fails silently                  | Export `APP_ID` from a shared module; always pass `walletAppKeyMessage(APP_ID)` in manual re-auth ceremonies                                                                                                                                                                              |
| Passing `APP_ID` (string) as third arg to `deriveAppKeyFromPasskey`                                   | TypeScript error — third param is `number`                                       | Pass `user.pbkdf2Iterations` (number) instead; this is the per-user pinned PBKDF2 iteration count                                                                                                                                                                                         |
| `lockOnHide: true` (default) on a page that uses `ExportKeyPanel` + wallet signing                    | Phantom popup backgrounds the tab → `status: session_expired` → panel disappears | Use `AuthProvider` directly with `lockOnHide: false` on that page instead of the shared `<Providers>` wrapper                                                                                                                                                                             |
| Checking `status === "locked"`                                                                        | TypeScript error — `"locked"` is not in `AuthStatus`                             | Use `auth.isLocked` (boolean); `status` only has `"authenticated" \| "session_expired" \| "unauthenticated"`                                                                                                                                                                              |
| Static `script-src 'self'` in `next.config.mjs`                                                       | Buttons don't work; CSP violation in console                                     | Move CSP to `proxy.ts` with per-request nonce                                                                                                                                                                                                                                             |
| `MemoryAdapter` in production / serverless                                                            | Each instance has its own store; sessions don't survive restarts                 | Set `REDIS_URL` / `KV_REST_API_URL` / `UPSTASH_REDIS_REST_URL`                                                                                                                                                                                                                            |
| `appKeyStorage: "session"` in config                                                                  | TypeScript error                                                                 | Removed in v0.3.0 — vault is memory-only; delete the option                                                                                                                                                                                                                               |
| Old `passkeyHash` records in storage after upgrading to v0.3.0                                        | Login returns 401 for all users                                                  | Wipe the store (`FLUSHDB` / restart) and re-register                                                                                                                                                                                                                                      |
| `trustProxyHeaders: true` without a real proxy                                                        | Rate-limit bypass; spoofed IPs                                                   | Only set `true` behind Vercel / Cloudflare / nginx you control                                                                                                                                                                                                                            |
| Calling `useBiometricUnlock().unlock()` after enrolling via `client.enableBiometricUnlock()` directly | "No biometric unlock is registered on this device" — vault stays locked          | `unlock()` only works if you enrolled through `useBiometricUnlock().enable()` (the hook holds the reg in a React ref). If you called `client.enableBiometricUnlock()` to capture the `PasskeyRegistration` return value, drive vault re-arm with `client.unlockViaBiometric(reg)` instead |
| Using `auth.reauthenticate({ biometricUnlock: reg })` for repeated lock/unlock cycles                 | Second unlock silently succeeds without Touch ID — biometric prompt never fires  | The general re-auth path can short-circuit on consecutive calls. Use `client.unlockViaBiometric(reg)` — it always runs the full Touch ID → unwrap stored key → re-arm vault path, forcing a fresh assertion every time.                                                                   |
