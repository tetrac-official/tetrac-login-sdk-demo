# PRD — Update demo to the post-audit `@tetrac/login-sdk` (security remediation, 2026-06-10)

The SDK shipped a security-remediation pass (see `tetrac-login-sdk/docs/5-PRD-FABLE-AUDIT.md`):
prod-storage fix, vault-lock enforcement at call time, non-extractable gate-mode WebAuthn,
session TTL + revocation + `logout` endpoint, response sanitization, payload validation,
proxy-header trust, and an RN-WebView default flip in `<ExportKeyPanel>`. This PRD captures
exactly what the demo (`tetrac-login-sdk-demo`) must change to consume it — which is little,
because the demo was already hotfix-aware (reveal ceremonies, unlock flows) — plus what must be
re-verified because SDK behavior under the demo changed.

- **Status:** Draft v1 — actionable
- **Author:** Fable (audit follow-up) / TTC Engineering
- **Date:** 2026-06-10
- **SDK source:** `../tetrac-login-sdk` (consumed via `file:` dependency)
- **References:** SDK `docs/5-PRD-FABLE-AUDIT.md`, SDK `docs/USE_IN_CODE.md` §3/§8/§11

---

## 1. Impact matrix

| SDK change | Demo impact | Action |
|---|---|---|
| `trustProxyHeaders` (default **false** → shared IP bucket) | **Breaks the public demo on Vercel**: all visitors share one rate-limit bucket (10 req/60s total) → spurious 429s | **Required** — §2.1 |
| `file:` dep + new `dist/` (yarn classic copies, doesn't symlink) | Demo keeps running the **old** SDK until reinstalled | **Required** — §2.2 |
| `<ExportKeyPanel>` `postToReactNativeWebView` default **true → false** | No behavior change (web demo, no RN shell), but `/ui` page copy now overstates ("handles the RN postMessage contract") | **Required (copy only)** — §2.3 |
| New `POST /logout` (server revocation; `AuthClient.logout()` calls it) | Works automatically via the existing catch-all route; route-file comment lists endpoints and is stale | **Required (comment only)** — §2.4 |
| Sessions expire (`sessionTtlSeconds` 24h) + old token revoked on re-login | Demo already handles `session_expired`; MemoryAdapter resets on dev-server restart anyway | Verify — §3 |
| Vault lock now enforced at **call time** (`VaultLockedError`, `useSyncExternalStore`) | Demo already gates on `auth.isLocked` + `reauthenticate()`; the 60s `autoLockMs` override still applies | Verify — §3 |
| Gate-mode WebAuthn: legacy plaintext IndexedDB records auto-migrate on first unlock | Transparent; biometric testers with pre-update records keep working | Verify — §3 |
| Responses sanitized (no `passkeyHash` / nested `authToken`) | Demo never reads either field (grep-confirmed) | None |
| `search-wallet` now IP rate-limited; `wallets[]` validated (cap 16) | Demo doesn't call `search-wallet`; default `walletGen` = 4 wallets | None |
| `"use client"` banner now baked into `dist/react` / `dist/ui` | Demo pages already declare `"use client"` themselves; no RSC errors either way | None |

---

## 2. Required changes

### 2.1 Route config — enable proxy trust when deployed (`app/api/auth/[...action]/route.ts`)

The SDK now ignores `x-forwarded-for` / `x-real-ip` by default (they're client-spoofable with
no proxy). On Vercel every request then lands in one shared `"unknown"` IP bucket — with the
default `rateLimit: { windowSeconds: 60, maxAttempts: 10 }`, ten clicks **across all visitors
combined** trigger 429s. Vercel is a trusted proxy, so enable the flag there; keep it off for
bare local dev:

```ts
export const { GET, POST } = createNextAuthRoutes({
  storage,
  config: {
    webauthn: { rpName: "TTC Login Demo" },
    // Vercel sets x-forwarded-for from its own edge — trust it there so rate
    // limiting is per-visitor. Local dev has no proxy: leave untrusted.
    trustProxyHeaders: !!process.env.VERCEL,
  },
});
```

(If the demo is ever fronted by another proxy — Cloudflare, nginx — extend the condition.)

### 2.2 Pick up the new SDK build (`package.json` is already correct — it's an install issue)

`"@tetrac/login-sdk": "file:../tetrac-login-sdk"` with **yarn classic copies the folder at
install time** — the demo keeps the stale `dist/` until forced. Steps:

```bash
# in ../tetrac-login-sdk
npm run build                      # fresh dist (banners, logout, lock fixes)

# in tetrac-login-sdk-demo
rm -rf node_modules/@tetrac/login-sdk
yarn install --force               # re-copies the file: dependency
npx tsc --noEmit                   # demo must typecheck against the new d.ts
```

Recommended (so installs stop being ambiguous): bump the SDK to `0.2.0` and reflect the
version in this demo's README badge/text. No `package.json` dependency-spec change is needed —
`file:` already points at the right place; only the copy is stale.

### 2.3 `/ui` page copy — RN postMessage is now opt-in (`app/ui/page.tsx`)

The card description says the panel "Handles auto-clear, clipboard wipe, and the
React-Native-WebView `postMessage` contract." Since the SDK flipped
`postToReactNativeWebView` to **default false** (it posts the plaintext key to any host
shell), the demo's panel no longer posts — and shouldn't. Update the copy to:

> Handles the per-method re-auth ceremony, auto-clear, and clipboard wipe. (RN-WebView
> `postMessage` is available but **opt-in** — only enable it inside a trusted native shell.)

Do **not** add `postToReactNativeWebView={true}` to the demo — a public web page must not
post key material to an ambient `window.ReactNativeWebView` bridge.

### 2.4 Route-file comment — list the new endpoint (`app/api/auth/[...action]/route.ts`)

The header comment enumerates the served endpoints; add `logout`:

```ts
// One catch-all route serves every SDK endpoint:
//   POST challenge | register | login | login-wallet | connect-wallet | import-wallet | logout
//   GET  user-data | search-wallet   (search-wallet is IP rate-limited)
```

No handler code changes — `createNextAuthRoutes` wires `logout` automatically, and the
existing logout buttons (`DemoShell`, `/ui`, `/bridge`) now revoke server-side for free via
`AuthClient.logout()`.

---

## 3. Behavior to re-verify (no code change expected)

Manual smoke pass after §2.2, all three methods (email / wallet / biometric):

- [ ] **Login → sign → idle 60s → sign again**: the SignMessageCard / bridge page must show
  the "Unlock to sign" ceremony (vault locked), and unlock must restore signing. The B2 fix
  means the lock is now enforced even without a re-render — the demo's gating should feel
  identical, just no longer bypassable.
- [ ] **Reveal flows** (`WalletsPanel` ceremony, `ExportKeyShowcase`, `/ui` panel): each
  reveal still prompts for credentials every time; biometric reveal triggers Face ID/Touch ID.
- [ ] **Logout** (all three buttons): network tab shows `POST /api/auth/logout` → `200 {ok:true}`;
  re-using the old token via `GET /user-data` returns 401.
- [ ] **Biometric legacy migration**: on a machine that registered a biometric account
  *before* this SDK update, re-login once — it must succeed, and the IndexedDB
  `ttc_passkey_store/gate_secrets` record changes from a string to a `{cryptoKey, iv,
  ciphertext}` object.
- [ ] **Rate limiting on Vercel preview**: two browsers / devices can both complete login
  flows without tripping shared 429s (proves §2.1).
- [ ] `npx tsc --noEmit` and `next build` pass.

---

## 4. Explicit non-goals

- No demo UX redesign — the hotfix-era ceremony/unlock UI already matches the SDK model.
- No switch off the `file:` dependency (workspaces/pnpm migration is a separate decision).
- No enabling of the RN-WebView bridge in the web demo (see §2.3).
- No changes to `app/lib/storage.ts` — the SDK's `MemoryAdapter` gained `getdel` internally;
  the demo's usage is unchanged.

---

## 5. Acceptance criteria

- §2.1–§2.4 applied; demo typechecks and builds against the freshly built SDK.
- On a Vercel deployment, per-visitor rate limiting works (no shared-bucket 429s).
- All §3 smoke checks pass for all three auth methods.
- The demo never posts key material to `window.ReactNativeWebView`.
