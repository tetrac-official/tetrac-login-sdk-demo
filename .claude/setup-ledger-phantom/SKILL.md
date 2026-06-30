# Skill: Phantom + Ledger sign-in with @tetrac/login-sdk

Integrate **hardware-secured sign-in through the Phantom extension** — where the
user's active Phantom account is backed by a **Ledger** — into a Next.js app using
`@tetrac/login-sdk` (≥ 0.4.1). Phantom forwards signing to the device, so the
account the user already picked in Phantom becomes the login identity.

## When to use this skill

- You already have `@tetrac/login-sdk` wired up (provider, auth routes, storage)
  and want to add a **Phantom + Ledger** login surface.
- You want users to authenticate with the Ledger account they manage **inside
  Phantom**, instead of talking to the device directly over WebUSB/WebHID.
- You're integrating into another project and want the minimal, copy-pasteable
  glue.

> **Prerequisite:** the base SDK integration (`AuthProvider`, `app/api/auth/[...action]`,
> storage adapter, CSP) must already exist. If not, do the **setup-tetrac-login-sdk**
> skill first — this skill only covers the Phantom + Ledger delta. There are **no
> server-side changes** for hardware login.

> **For the direct-device alternative** (native WebUSB/WebHID via
> `@tetrac/login-sdk/ledger`, no extension), see the Ledger section of
> **setup-tetrac-login-sdk**. Pick one path per account (see Hard constraints).

---

## Mental model (read this first)

The SDK is **provider-agnostic**: `connectWallet()` only needs
`{ publicKey, signMessage, hardwareWallet }`. It does not care whether
`signMessage` is backed by software Phantom, direct WebUSB, or **Phantom→Ledger**.

A Ledger cannot sign raw bytes — it signs a Solana **off-chain message envelope**,
and its firmware only clear-signs **newline-free printable ASCII**. The single knob
that handles this is **`hardwareWallet: true`**, which switches the app-key message
to the newline-free variant the device can clear-sign and the key derives from.

So "Phantom + Ledger" = the normal injected-wallet flow **plus** `hardwareWallet:
true` whenever the active account is hardware-backed.

---

## Install

Nothing beyond the base SDK. You do **not** need the `@ledgerhq/*` transport
packages (those are only for the direct-WebUSB path) — Phantom owns the device.

```bash
# already present from the base setup:
#   @tetrac/login-sdk  @solana/web3.js  tweetnacl
```

---

## Step 1 — Phantom provider glue (drop-in `lib/phantomLedger.ts`)

A small reusable module: detect the injected wallet, normalize `signMessage`, and
classify the active account as software vs Ledger-backed.

```ts
// lib/phantomLedger.ts
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { offchainMessageCandidates } from "@tetrac/login-sdk/ledger";

/** Shape of the injected Solana provider Phantom (and most others) expose. */
export type InjectedSolana = {
  isConnected?: boolean;
  publicKey?: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<unknown>;
  disconnect: () => Promise<void>;
  signMessage: (m: Uint8Array, display?: string) => Promise<{ signature: Uint8Array } | Uint8Array>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  off?: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
};

export function getInjectedSolana(): InjectedSolana | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { solana?: InjectedSolana; phantom?: { solana?: InjectedSolana } };
  return w.phantom?.solana ?? w.solana ?? null;
}

/** Normalize Phantom's signMessage return ({signature} | Uint8Array) to bytes. */
export function phantomSignMessage(provider: InjectedSolana) {
  return async (m: Uint8Array): Promise<Uint8Array> => {
    const res = await provider.signMessage(m, "utf8");
    return res instanceof Uint8Array ? res : res.signature;
  };
}

export type AccountType = "software" | "hardware" | "unknown";

/**
 * Classify the active account by signing a short ASCII probe and checking what
 * the signature verifies against. Phantom exposes no "isLedger" flag, so this is
 * the reliable detection. Costs one signature (one device tap for a Ledger).
 */
export async function detectAccountType(provider: InjectedSolana, address: string): Promise<AccountType> {
  const probe = new TextEncoder().encode("account capability check");
  const sig = await phantomSignMessage(provider)(probe);
  const pk = new PublicKey(address).toBytes();
  if (nacl.sign.detached.verify(probe, sig, pk)) return "software"; // signed raw bytes
  if (offchainMessageCandidates(probe, pk).some((env) => nacl.sign.detached.verify(env, sig, pk)))
    return "hardware"; // signed the off-chain envelope → Ledger-backed
  return "unknown";
}
```

---

## Step 2 — Sign in (the whole flow)

```tsx
"use client";

import { useState } from "react";
import { useAuth } from "@tetrac/login-sdk/react";
import { getInjectedSolana, phantomSignMessage, detectAccountType } from "../lib/phantomLedger";

export function PhantomLedgerLogin() {
  const auth = useAuth();
  const [address, setAddress] = useState<string | null>(null);
  const [isHardware, setIsHardware] = useState(true); // Ledger-focused default

  async function connect() {
    const provider = getInjectedSolana();
    if (!provider) throw new Error("No Solana wallet detected — install Phantom.");
    await provider.connect();
    const pk = provider.publicKey?.toString();
    if (!pk) throw new Error("Phantom did not return a public key");
    setAddress(pk);
    // Optional but recommended: auto-classify so hardwareWallet is correct.
    setIsHardware((await detectAccountType(provider, pk)) !== "software");
  }

  async function signIn() {
    const provider = getInjectedSolana();
    if (!provider || !address) throw new Error("Connect Phantom first");
    // connectWallet = login if known, else register. For a Ledger-backed account
    // it prompts the DEVICE twice (ownership + app-key); for software it's two
    // Phantom popups.
    await auth.connectWallet({
      publicKey: address,
      signMessage: phantomSignMessage(provider),
      hardwareWallet: isHardware, // ← the one flag that makes Ledger work
    });
  }

  return (
    <>
      {!address ? (
        <button onClick={connect}>Connect Phantom</button>
      ) : (
        <button onClick={signIn}>Sign in {isHardware ? "(Ledger)" : "(software)"}</button>
      )}
    </>
  );
}
```

`connectWallet` covers register **and** login. To split them explicitly, the same
params apply to `auth.registerWithWallet({...})` and `auth.loginWithWallet({...})`.

---

## Step 3 — AuthProvider config for the page

Wrap the page in its own `AuthProvider` (don't reuse a default-config wrapper):

```tsx
import { AuthProvider } from "@tetrac/login-sdk/react";
import { APP_ID } from "../lib/appConfig";

export default function Page() {
  return (
    <AuthProvider
      apiBaseUrl="/api/auth"
      // lockOnHide:false — the Phantom popup AND the device confirmation briefly
      // background the tab; the default `true` would lock the vault before the
      // signature returns. walletGen: a single signing agent → one embedded blob.
      config={{ appId: APP_ID, autoLockMs: 120_000, lockOnHide: false }}
      walletGen={{ solana: ["signing"] }}
    >
      <PhantomLedgerLogin />
    </AuthProvider>
  );
}
```

---

## Step 4 — Unlock & reveal (the consistency rule)

A hardware account derives its app key from the **newline-free** message, so
**every** ceremony that re-derives that key must pass the **same** `hardwareWallet`
value used at sign-in. Mixing forms derives a different key and silently fails to
decrypt.

```tsx
import { useExportKey } from "@tetrac/login-sdk/react";

// Re-arm the vault after an auto-lock:
await auth.reauthenticate({ signMessage: phantomSignMessage(provider), hardwareWallet: isHardware });

// Reveal a wallet's plaintext key behind a fresh approval (auto-clears):
const { reveal, clear, plaintext, loading } = useExportKey(embeddedWallet, { autoClearMs: 60_000 });
await reveal({ signMessage: phantomSignMessage(provider), hardwareWallet: isHardware });
```

> **Verifying a Ledger signature yourself?** It verifies against the **envelope**,
> not the raw bytes. Use `offchainMessageCandidates(msg, pkBytes)` from
> `@tetrac/login-sdk/ledger`, not `nacl.sign.detached.verify(msg, …)`. (The
> embedded agent wallet is a normal software key — verify _its_ signatures raw.)

---

## Hard constraints & caveats

| #   | Constraint                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Phantom must support Ledger _message_ signing.** It's reliable for _transaction_ signing but historically spotty for off-chain messages — which is what this SDK authenticates with. When `provider.signMessage` throws for a Ledger account, fall back to the direct-WebUSB path.                                                                              |
| 2   | **Don't mix provider paths per account.** The app key is derived from the **exact signature bytes**, and Phantom may emit a different off-chain envelope than the direct-WebUSB cascade. An account registered via Phantom may _log in_ via direct WebUSB (the server tries all candidates) **but its embedded blob won't _decrypt_**. Pick one path per account. |
| 3   | **No `isLedger` flag.** Detect via the probe in Step 1, or ask the user. On a Ledger-focused page, defaulting `hardwareWallet: true` + an optional probe is fine.                                                                                                                                                                                                 |
| 4   | **Pass `hardwareWallet` identically** at register, login, `reauthenticate`, and `reveal` (Step 4).                                                                                                                                                                                                                                                                |
| 5   | **Re-auth on account change.** Subscribe to the provider's `accountChanged` event; a different Phantom account is a different identity — `logout()` and require a fresh sign-in.                                                                                                                                                                                  |
| 6   | **Browser/runtime:** Chrome/Edge over HTTPS (or localhost), the Ledger unlocked with the **Solana app open**, and the Ledger account added to Phantom.                                                                                                                                                                                                            |

---

## Common mistakes

| Mistake                                                                      | Symptom                                                                                                     | Fix                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Omitting `hardwareWallet: true` for a Ledger-backed Phantom account          | Device rejects with `0x6a82` / demands Blind Signing, or login "works" but the embedded blob never decrypts | Pass `hardwareWallet: true`; it selects the newline-free message |
| `hardwareWallet: true` at login but omitted on `reveal()` / `reauthenticate` | Unlock/reveal derives a different key → decrypt fails silently                                              | Use one `isHardware` value to drive **every** ceremony           |
| Registering on Phantom, logging in on direct WebUSB (or vice-versa)          | Login succeeds but the embedded vault won't decrypt                                                         | Bind each account to one path (caveat 2)                         |
| Verifying a Ledger signature with `nacl.sign.detached.verify(msg, sig, pk)`  | Verification fails though the device signed correctly                                                       | Verify against `offchainMessageCandidates(msg, pk)`              |
| `lockOnHide: true` (default) on the page                                     | Popup/device prompt backgrounds the tab → `session_expired` mid-sign                                        | Instantiate `AuthProvider` with `lockOnHide: false` on this page |
| Assuming Phantom exposes which account is a Ledger                           | Wrong `hardwareWallet` value                                                                                | Probe (Step 1) or ask the user                                   |

---

## Test checklist

- [ ] Ledger-backed Phantom account: connect → sign in (2 device approvals) →
      authenticated under the Phantom-selected address.
- [ ] Embedded agent wallet decrypts and signs; signature verifies (raw).
- [ ] `reveal()` shows the embedded private key after a fresh approval; auto-clears.
- [ ] Software Phantom account (probe → `hardwareWallet:false`): full flow works.
- [ ] `provider.signMessage` failure on a Ledger account → actionable error /
      fallback to the direct-WebUSB page.
- [ ] Switching accounts in Phantom logs out and forces re-auth.
- [ ] `tsc --noEmit` clean.

---

## Reference implementation

A complete, working page that exercises every step above (connect, probe, sign in,
test-signature, embedded decrypt-and-sign, reveal, account-change handling) lives at
`app/ledger-phantom/page.tsx` in the tetrac-login-sdk-demo, with the full design
rationale in `docs/prd-ledger-phantom.md`.
