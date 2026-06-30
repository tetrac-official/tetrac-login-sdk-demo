# PRD — `/ledger-phantom`: Phantom external wallet with Ledger signing

| Field      | Value                                                   |
| ---------- | ------------------------------------------------------- |
| Status     | Draft                                                   |
| Owner      | TTC                                                     |
| Date       | 2026-06-30                                              |
| SDK        | `@tetrac/login-sdk` ≥ 0.4.3                             |
| Route      | `/ledger-phantom` (**new** — does not modify `/ledger`) |
| Supersedes | nothing — sits alongside `/ledger` (direct WebUSB)      |

---

## 1. Summary

Add a second hardware-wallet demo page, `/ledger-phantom`, that signs in through the
**Phantom browser extension** instead of talking to the Ledger directly over
WebUSB/WebHID. When the user's active Phantom account is **backed by a Ledger**,
Phantom forwards signing requests to the device — so the address the user already
selected inside Phantom becomes the login identity, and the Ledger provides the
hardware security.

The existing `/ledger` page (direct WebUSB derivation) stays exactly as-is. This is
purely additive.

---

## 2. Background & motivation

The current [`/ledger`](../app/ledger/page.tsx) page connects to the device
directly: `useSolanaLedger()` opens a WebUSB/WebHID transport, derives addresses on
`m/44'/501'/i'/0'`, and the user picks one from a derived list. **Phantom is never
involved, and the account the user has already chosen inside Phantom is ignored.**

That is a deliberate reliability choice (see §10), but it has real downsides:

- Users must re-derive and re-select an address that already exists in Phantom.
- The flow diverges from every other wallet surface in the app, which all use the
  injected `window.solana` provider (see [`/bridge`](../app/bridge/page.tsx) and
  `DemoShell`).
- It can't reuse Phantom's account UI, labels, or multi-account switching.

**Key enabling insight:** the SDK is **provider-agnostic**. `connectWallet()` only
takes `{ publicKey, signMessage, hardwareWallet? }` — it does not care whether
`signMessage` is backed by direct WebUSB, software Phantom, or Phantom→Ledger. The
only hardware-specific knob is `hardwareWallet: true`, which selects the
newline-free app-key message a Ledger can clear-sign. That means a Phantom-driven
Ledger login is achievable with the **same** SDK calls the other pages already use.

---

## 3. Goals / Non-goals

### Goals

1. Sign in via `auth.connectWallet({ publicKey, signMessage, hardwareWallet })`
   where `publicKey` is the **Phantom-selected account** and `signMessage` routes
   through the injected provider (and thus to the Ledger when the account is
   hardware-backed).
2. Correctly handle the hardware case: newline-free app-key message
   (`hardwareWallet: true`) and off-chain-envelope signature verification.
3. Reuse the embedded-wallet **decrypt-and-sign** and **reveal private key**
   features (the `useExportKey` flow added to `/ledger`), driven by the Phantom
   signer.
4. Detect whether the active Phantom account is hardware-backed and adapt, with a
   manual override for testing.
5. Leave `/ledger` untouched; add a discoverable link from the home page.

### Non-goals

- Replacing or deprecating `/ledger` (direct WebUSB stays the guaranteed path).
- Supporting EVM / Ledger-Ethereum (Solana off-chain messages only).
- Cross-path account portability between `/ledger` and `/ledger-phantom` (see §10.2
  — explicitly out of scope; accounts are bound to the path that created them).
- Bundling a wallet-adapter library — we subscribe to `window.solana` directly, as
  the rest of the app does.

---

## 4. User stories

- **As a Phantom+Ledger user**, I connect Phantom, approve on my device, and I'm
  signed in under the address I picked in Phantom — without a separate "derive
  addresses" step.
- **As the same user**, I can decrypt-and-sign with my embedded agent wallet and
  reveal its private key, each behind a fresh on-device approval.
- **As a plain software-Phantom user** (testing), the page still works and tells me
  my account is software-backed (not a Ledger).
- **As a user whose Phantom can't message-sign with Ledger**, I get a clear error
  pointing me to the direct-device `/ledger` page.

---

## 5. UX / page layout

Mirror the structure and styling of `/ledger` and `/bridge` (hero + numbered step
cards on the left, Session + Activity sidebar on the right). Reuse existing CSS
classes (`.card`, `.panel-head`, `.wallet-row`, `.secret`, `.sig-result`,
`.unlocked-tag`, `.badge-sol`, `.btn-*`, `.mini-btn`).

```
┌ hero ────────────────────────────────────────────────┐
│ eyebrow: @tetrac/login-sdk · Phantom + Ledger        │
│ h1: Sign in with Phantom (Ledger-backed)             │
│ note: requires Phantom with a Ledger account added,  │
│       device unlocked, Solana app open               │
│ ← Back to demo                                        │
└──────────────────────────────────────────────────────┘

LEFT COLUMN                                  SIDEBAR
┌ 1 · Connect Phantom ─────────────┐         ┌ Session ─────────┐
│ Connect / Disconnect             │         │ status, publicKey│
│ shows provider.publicKey         │         │ account type     │
│ [Detect account type] (optional) │         │ Sign out         │
└──────────────────────────────────┘         └──────────────────┘
┌ 2 · Sign in ─────────────────────┐         ┌ Activity ────────┐
│ connectWallet({hardwareWallet})  │         │ timestamped log  │
│ "Approve 2 prompts on device…"   │         └──────────────────┘
│ [Test: sign a message]           │
└──────────────────────────────────┘
┌ 3 · Embedded wallet decrypts ────┐ (authed)
│ decrypt & sign embedded agent    │
└──────────────────────────────────┘
┌ 4 · Reveal the private key ──────┐ (authed)
│ useExportKey reveal via Phantom  │
└──────────────────────────────────┘
```

A small **"Account type" indicator** (Software / Ledger-backed / Unknown) sits in
the sidebar, plus an override toggle ("Treat as hardware wallet") for testing.

---

## 6. Detailed flow

1. **Connect Phantom.** `getInjectedSolana()` → `provider.connect()`. Use
   `provider.publicKey` as the login address. Subscribe to `connect`/`disconnect`/
   `accountChanged` so switching accounts in Phantom updates the page (and forces
   re-auth, since a different account = different identity).
2. **Determine hardware-ness** (see §7.2). Default assumption on this page is
   **hardware = true**. An optional "Detect account type" preflight confirms it and
   warns on mismatch; a manual toggle overrides.
3. **Sign in.**
   ```ts
   const signMessage = async (m: Uint8Array) => {
     const res = await provider.signMessage(m, "utf8");
     return res instanceof Uint8Array ? res : res.signature;
   };
   await auth.connectWallet({
     publicKey: provider.publicKey!.toString(),
     signMessage,
     hardwareWallet: isHardware, // true for a Ledger-backed account
   });
   ```
   For a Ledger-backed account this triggers **two device approvals** (ownership +
   app-key); for software Phantom it's two extension popups.
4. **Test signature (optional).** Sign an arbitrary message via the same
   `signMessage`. Verify with `nacl.sign.detached.verify(msg, sig, pk)` for
   software, or `offchainMessageCandidates(msg, pk).some(env => verify(env, …))`
   for hardware. (Pick the verifier by `isHardware`.)
5. **Embedded decrypt-and-sign.** `useSolanaSigner(embeddedWallet)` →
   `signer.signMessage(...)`, verified locally (raw — the embedded key is a
   software ed25519 key, never the Ledger).
6. **Reveal private key.** `useExportKey(embeddedWallet)` → `reveal({ signMessage,
hardwareWallet: isHardware })`. The same `hardwareWallet` value as login is
   mandatory (§10.1). Auto-clears after 60 s; Copy / Clear-now controls.
7. **Logout / disconnect.** `auth.logout()` and `provider.disconnect()`.

---

## 7. Technical design

### 7.1 AuthProvider configuration

```tsx
<AuthProvider
  apiBaseUrl="/api/auth"
  // Phantom's popup AND the device confirmation background the tab; lockOnHide
  // must be false or the vault locks before the signature returns.
  config={{ appId: APP_ID, autoLockMs: 120_000, lockOnHide: false }}
  // One signing agent → exactly one embedded blob to demo (matches /ledger).
  walletGen={{ solana: ["signing"] }}
>
```

Optionally also pass `externalSolanaAddress={phantomAddress}` and use
`useActiveWallet()` (the `/bridge` pattern) if we want the "external wins, else
embedded" display. Not required for the core flow.

### 7.2 Hardware detection (probe)

Phantom exposes **no `isLedger` flag**, so detect by probing once at connect:

```ts
// Sign a short, newline-free ASCII probe (safe for a Ledger to clear-sign).
const probe = new TextEncoder().encode("tetrac account check");
const sig = await signMessage(probe);
const pk = new PublicKey(address).toBytes();

const isSoftware = nacl.sign.detached.verify(probe, sig, pk);
const isHardware =
  !isSoftware && offchainMessageCandidates(probe, pk).some((env) => nacl.sign.detached.verify(env, sig, pk));
// neither → unknown/unsupported (likely Phantom can't message-sign this account)
```

- Software account → sig verifies over **raw** bytes.
- Ledger-backed → sig verifies over an **off-chain envelope** candidate.
- Throws / neither → surface the §10.3 error and point to `/ledger`.

Tradeoff: the probe costs one extra device approval. Because this page is
Ledger-focused, an acceptable alternative is to **default `isHardware = true`** and
make the probe an optional diagnostic; the manual toggle covers the software-test
case. (Recommended: default-true + optional probe.)

### 7.3 Why `hardwareWallet: true` matters

A Ledger signs the Solana **off-chain message envelope**, and its firmware only
clear-signs newline-free printable ASCII. `hardwareWallet: true` switches the
app-key message from `walletAppKeyMessage(appId)` (has a newline) to
`walletAppKeyMessageHw(appId)` (newline-free). Omit it and the device rejects
(status `0x6a82`) or demands Blind Signing — and the SDK derives the key from the
wrong domain string, so the embedded blob never decrypts.

### 7.4 Server: no changes

`createNextAuthRoutes()` already verifies hardware logins —
`verifySolanaSignature` tries the raw encoding first, then every off-chain envelope
candidate, each still embedding the single-use challenge (replay protection
unchanged). **No Ledger-specific or Phantom-specific server config.**

### 7.5 Reuse, don't fork

The embedded decrypt-and-sign card and the reveal card are identical to `/ledger`
except the signer comes from Phantom instead of `ledger.getSolanaSigner()`. Factor
the shared bits (shorten/toBase64 helpers, the reveal card markup) but keep this a
standalone page file so `/ledger` is never touched.

---

## 8. Constraints & caveats

These are the load-bearing risks; the page UX must make them legible.

### 8.1 Pass `hardwareWallet` identically everywhere

A hardware account derives its app key from the newline-free message. **Register,
login, unlock, and reveal must all pass the same `hardwareWallet` value.** Mixing
derives a different key and silently fails to decrypt.

### 8.2 Do not mix provider paths per account (hard constraint)

The app key is `deriveAppKeyFromSignature(toHex(sig))` — derived from the exact
signature **bytes**. Phantom and the SDK's direct-WebUSB cascade may wrap the
message in **different** off-chain envelope formats (legacy 20-byte vs v0 85-byte),
producing different signatures → different keys.

Consequence: an account **registered on `/ledger`** may authenticate on
`/ledger-phantom` (server-side login tries all candidates) **but its embedded
vault won't decrypt** (client re-derives a different key). Treat the two pages as
**independent registration paths**. The page should warn if it detects a likely
cross-path mismatch (embedded decrypt fails right after a successful login).

### 8.3 Phantom ↔ Ledger message-signing support (the main dependency)

Phantom + Ledger is solid for **transaction** signing, but this SDK authenticates
with **message** signatures, and Phantom's Ledger message-signing support has
historically been the weak spot. This page is only as reliable as the user's
Phantom version. When `provider.signMessage` throws for a Ledger account, fall back
with a clear pointer to `/ledger` (direct WebUSB, guaranteed).

### 8.4 Account switching

Switching accounts inside Phantom (`accountChanged`) changes the identity. The page
must drop the session (`auth.logout()`), clear any revealed secret, and require a
fresh sign-in.

---

## 9. `/ledger` vs `/ledger-phantom`

| Aspect            | `/ledger` (existing)                      | `/ledger-phantom` (new)                                 |
| ----------------- | ----------------------------------------- | ------------------------------------------------------- |
| Transport         | Direct WebUSB/WebHID (`useSolanaLedger`)  | Phantom injected provider (`window.solana`)             |
| Address source    | Derived on-device, user selects from list | The account already selected in Phantom                 |
| Deps              | `@ledgerhq/*` transport packages          | none beyond what `/bridge` already uses                 |
| Message signing   | Guaranteed (SDK speaks to device)         | Depends on Phantom's Ledger message support             |
| Envelope handling | SDK cascades legacy→v0                    | Whatever Phantom emits (must stay consistent)           |
| `hardwareWallet`  | Always `true`                             | `true` when account is Ledger-backed (detected/toggled) |
| Best for          | Reliability, no extension required        | UX parity with Phantom, reuse selected account          |

---

## 10. Error handling matrix

| Condition                                      | Behavior                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| No injected provider                           | Hint: "No Solana wallet detected — install Phantom." Disable connect. |
| `provider.connect()` rejected                  | Log "Connect — rejected"; stay disconnected.                          |
| `signMessage` throws (Ledger msg unsupported)  | Log the device error; banner pointing to `/ledger` (direct WebUSB).   |
| Probe verifies as neither raw nor envelope     | Mark account type "Unknown"; warn before sign-in.                     |
| Login OK but embedded decrypt fails            | Surface likely cross-path mismatch (§8.2); suggest re-register here.  |
| `accountChanged` while authed                  | Logout, clear secrets, require re-auth.                               |
| Reveal without `hardwareWallet` matching login | Prevented by construction (single `isHardware` value drives both).    |

---

## 11. Acceptance criteria

1. `/ledger-phantom` exists; `/ledger` is byte-for-byte unchanged.
2. With a Ledger-backed Phantom account: connect → sign in (2 device approvals) →
   authenticated under the Phantom-selected address.
3. Embedded agent wallet decrypts and signs; signature verifies locally.
4. Reveal shows the embedded private key after a fresh device approval; auto-clears
   after 60 s; Copy and Clear-now work.
5. With a software Phantom account (toggle/override): the full flow still works and
   the account type reads "Software".
6. When Phantom can't message-sign a Ledger account, the user gets an actionable
   error pointing to `/ledger`.
7. `tsc --noEmit` clean; Prettier clean; home page links to the new route.

---

## 12. Risks & open questions

- **R1 (high):** Phantom Ledger message-signing reliability (§8.3). Mitigation:
  graceful fallback to `/ledger`.
- **R2 (med):** Envelope-format parity between Phantom and the SDK's direct path
  (§8.2). Open question: can we pin both to the legacy 20-byte envelope to make
  `/ledger` and `/ledger-phantom` accounts interoperable? Needs investigation of
  what envelope Phantom emits. Until answered, treat paths as independent.
- **R3 (low):** Extra probe approval friction (§7.2). Mitigation: default-true +
  optional probe.
- **R4 (low):** `accountChanged` edge cases across Phantom versions.

---

## 13. Implementation checklist

- [ ] `app/ledger-phantom/page.tsx` — new page with its own `AuthProvider`
      (`lockOnHide: false`, `walletGen: { solana: ["signing"] }`).
- [ ] Phantom wiring: `getInjectedSolana()`, connect/disconnect, `connect` /
      `disconnect` / `accountChanged` subscriptions.
- [ ] Hardware detection probe + manual override toggle + account-type indicator.
- [ ] Sign-in via `connectWallet({ publicKey, signMessage, hardwareWallet })`.
- [ ] Test-signature card with verifier selected by `isHardware`.
- [ ] Embedded decrypt-and-sign card (`useSolanaSigner`).
- [ ] Reveal card (`useExportKey`, `reveal({ signMessage, hardwareWallet })`).
- [ ] Cross-path mismatch detection + fallback banner to `/ledger`.
- [ ] Home page: add "Phantom + Ledger" link next to "Ledger login".
- [ ] Skill doc: note the Phantom-via-Ledger variant under the Ledger section.
- [ ] `tsc --noEmit` + Prettier; manual device test.

---

## 14. Out of scope / future

- Interop between `/ledger` and `/ledger-phantom` accounts (pending R2).
- Other injected wallets that proxy Ledger (Solflare, Backpack) — likely work via
  the same `window.solana` shape but untested.
- EVM / Ledger-Ethereum.
