"use client";

// Phantom (external wallet) + Ledger signing — the companion to /ledger.
//
// Where /ledger talks to the device DIRECTLY over WebUSB/WebHID, this page signs
// in through the Phantom browser extension. When the user's active Phantom
// account is BACKED BY A LEDGER, Phantom forwards signing to the device — so the
// address already selected inside Phantom becomes the login identity and the
// Ledger provides the hardware security.
//
// This works because the SDK is provider-agnostic: connectWallet() only needs
// { publicKey, signMessage, hardwareWallet }. The single hardware-specific knob
// is hardwareWallet: true, which selects the newline-free app-key message a
// Ledger can clear-sign (a newline triggers 0x6a82 / blind-signing).
//
// IMPORTANT (PRD §8.2): the app key is derived from the exact signature bytes,
// and Phantom may wrap the off-chain message in a different envelope than the
// SDK's direct-WebUSB cascade. So an account registered on /ledger may LOG IN
// here but its embedded vault won't decrypt. Treat the two pages as independent
// registration paths; this page detects the mismatch and points back to /ledger.
//
// Requirements: Phantom installed, a Ledger added to it (for the hardware path),
// the device unlocked with the Solana app open.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { AuthProvider, useAuth, useUser, useSolanaSigner, useExportKey } from "@tetrac/login-sdk/react";
import { offchainMessageCandidates } from "@tetrac/login-sdk/ledger";
import type { EncryptedWallet } from "@tetrac/login-sdk/core";
import { APP_ID } from "../lib/appConfig";

type LogLine = { ok: boolean; msg: string; time: string };
type AccountType = "software" | "hardware" | "unknown";

// Shape of the injected Solana provider Phantom (and most others) expose.
type InjectedSolana = {
  isConnected?: boolean;
  publicKey?: { toString(): string } | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<unknown>;
  disconnect: () => Promise<void>;
  signMessage: (m: Uint8Array, display?: string) => Promise<{ signature: Uint8Array } | Uint8Array>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  off?: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
};

function getInjectedSolana(): InjectedSolana | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { solana?: InjectedSolana; phantom?: { solana?: InjectedSolana } };
  return w.phantom?.solana ?? w.solana ?? null;
}

// Normalize Phantom's signMessage return ({signature} | Uint8Array) to bytes.
function makeSignMessage(provider: InjectedSolana) {
  return async (m: Uint8Array): Promise<Uint8Array> => {
    const res = await provider.signMessage(m, "utf8");
    return res instanceof Uint8Array ? res : res.signature;
  };
}

function shorten(key: string): string {
  return key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key;
}
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function LedgerPhantomInner() {
  const auth = useAuth();
  const { user } = useUser();

  const [address, setAddress] = useState<string | null>(null);
  // This page is Ledger-focused, so default to the hardware path. The probe
  // (§7.2) or the manual toggle can flip it for a plain software Phantom account.
  const [isHardware, setIsHardware] = useState(true);
  const [accountType, setAccountType] = useState<AccountType | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [deviceSig, setDeviceSig] = useState<{ valid: boolean; signature: string } | null>(null);
  const [embeddedSig, setEmbeddedSig] = useState<{ valid: boolean; signature: string } | null>(null);
  // Set when a successful login is followed by a failed embedded decrypt — the
  // tell-tale of a cross-path account (registered on /ledger, see PRD §8.2).
  const [mismatch, setMismatch] = useState(false);

  const say = useCallback(
    (ok: boolean, msg: string) =>
      setLog((l) => [{ ok, msg, time: new Date().toLocaleTimeString() }, ...l].slice(0, 40)),
    [],
  );

  async function run(label: string, key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      say(false, `${label} — ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  // The embedded agent wallet generated at sign-up (encrypted under the key the
  // Phantom→Ledger signature derives). A ready signer over it proves it decrypts.
  const embeddedWallet = useMemo<EncryptedWallet | null>(
    () => user?.wallets.find((w) => w.chain === "solana" && w.role === "signing") ?? user?.wallets[0] ?? null,
    [user],
  );
  const embeddedSigner = useSolanaSigner(embeddedWallet);

  // Reveal the embedded private key behind a fresh ceremony — re-derives a
  // one-time key from a new Phantom signature, honoring "Re-auth to reveal".
  const {
    reveal: revealEmbedded,
    clear: clearEmbedded,
    plaintext: embeddedSecret,
    loading: revealLoading,
  } = useExportKey(embeddedWallet, { autoClearMs: 60_000 });

  // Latest values for the once-mounted provider subscription, so its handlers
  // never close over a stale auth/clear reference.
  const authRef = useRef(auth);
  authRef.current = auth;
  const clearRef = useRef(clearEmbedded);
  clearRef.current = clearEmbedded;

  // Subscribe to the injected wallet's connect/disconnect/accountChanged events.
  useEffect(() => {
    const provider = getInjectedSolana();
    if (!provider) return;

    if (provider.publicKey) setAddress(provider.publicKey.toString());

    const onConnect = () => setAddress(provider.publicKey?.toString() ?? null);
    const onDisconnect = () => {
      setAddress(null);
      setAccountType(null);
      setMismatch(false);
      clearRef.current();
    };
    // A different Phantom account is a different identity: drop the session and
    // any revealed secret, and require a fresh sign-in (PRD §8.4).
    const onAccountChanged = () => {
      const pk = provider.publicKey?.toString() ?? null;
      setAddress(pk);
      setAccountType(null);
      setMismatch(false);
      setEmbeddedSig(null);
      setDeviceSig(null);
      clearRef.current();
      if (authRef.current.isAuthenticated) authRef.current.logout();
      say(true, pk ? `Account changed → ${shorten(pk)} (re-auth required)` : "Account disconnected");
    };

    provider.on?.("connect", onConnect);
    provider.on?.("disconnect", onDisconnect);
    provider.on?.("accountChanged", onAccountChanged);
    return () => {
      provider.off?.("connect", onConnect);
      provider.off?.("disconnect", onDisconnect);
      provider.off?.("accountChanged", onAccountChanged);
      provider.removeListener?.("connect", onConnect);
      provider.removeListener?.("disconnect", onDisconnect);
      provider.removeListener?.("accountChanged", onAccountChanged);
    };
  }, [say]);

  const hasInjected = typeof window !== "undefined" && !!getInjectedSolana();

  // --- 1. Connect Phantom ---
  const connect = () =>
    run("Connect Phantom", "connect", async () => {
      const provider = getInjectedSolana();
      if (!provider) throw new Error("No Solana wallet detected — install Phantom.");
      await provider.connect();
      const pk = provider.publicKey?.toString();
      if (!pk) throw new Error("Phantom did not return a public key");
      setAddress(pk);
      say(true, `Phantom connected — ${shorten(pk)}`);
    });

  const disconnect = () =>
    run("Disconnect", "disconnect", async () => {
      const provider = getInjectedSolana();
      await provider?.disconnect();
      setAddress(null);
      setAccountType(null);
      setDeviceSig(null);
      setEmbeddedSig(null);
      setMismatch(false);
      say(true, "Phantom disconnected");
    });

  // --- Probe: is the active account software or Ledger-backed? (PRD §7.2) ---
  const detectAccountType = () =>
    run("Detect account type", "detect", async () => {
      const provider = getInjectedSolana();
      if (!provider || !address) throw new Error("Connect Phantom first");
      // Newline-free ASCII probe so a Ledger can clear-sign it.
      const probe = new TextEncoder().encode("tetrac account check");
      const sig = await makeSignMessage(provider)(probe);
      const pk = new PublicKey(address).toBytes();
      if (nacl.sign.detached.verify(probe, sig, pk)) {
        setAccountType("software");
        setIsHardware(false);
        say(true, "Account type: software Phantom (raw signature)");
      } else if (
        offchainMessageCandidates(probe, pk).some((env) => nacl.sign.detached.verify(env, sig, pk))
      ) {
        setAccountType("hardware");
        setIsHardware(true);
        say(true, "Account type: Ledger-backed (off-chain envelope)");
      } else {
        setAccountType("unknown");
        say(false, "Could not classify the signature — proceed with caution");
      }
    });

  // --- 2. Sign in via connectWallet (provider-agnostic) ---
  const signIn = () =>
    run("Sign in", "signin", async () => {
      const provider = getInjectedSolana();
      if (!provider || !address) throw new Error("Connect Phantom first");
      setMismatch(false);
      // hardwareWallet: isHardware → newline-free app-key message for a Ledger.
      // For a Ledger-backed account this prompts the device TWICE (ownership +
      // app-key); for a software account it's two Phantom popups.
      await auth.connectWallet({
        publicKey: address,
        signMessage: makeSignMessage(provider),
        hardwareWallet: isHardware,
      });
      say(true, `Signed in as ${shorten(address)} (${isHardware ? "hardware" : "software"} path)`);
    });

  // --- Test signature through Phantom (verify by account type) ---
  const signWithProvider = () =>
    run("Provider signMessage", "devsign", async () => {
      const provider = getInjectedSolana();
      if (!provider || !address) throw new Error("Connect Phantom first");
      const msg = new TextEncoder().encode(`Hello from Phantom @ ${new Date().toISOString()}`);
      const sig = await makeSignMessage(provider)(msg);
      const pk = new PublicKey(address).toBytes();
      // Hardware accounts sign the off-chain envelope; software sign raw bytes.
      const valid = isHardware
        ? offchainMessageCandidates(msg, pk).some((env) => nacl.sign.detached.verify(env, sig, pk))
        : nacl.sign.detached.verify(msg, sig, pk);
      setDeviceSig({ valid, signature: toBase64(sig) });
      say(valid, `Signature ${valid ? "verified" : "FAILED"} (${isHardware ? "envelope" : "raw"})`);
    });

  // --- 3. Embedded blob decrypts (also the cross-path mismatch detector) ---
  const signWithEmbedded = () =>
    run("Embedded signMessage", "embsign", async () => {
      if (!embeddedWallet) throw new Error("No embedded wallet on this account");
      if (auth.isLocked) throw new Error("Vault locked");
      // Armed session but no signer → the blob won't decrypt under this key.
      if (!embeddedSigner) {
        setMismatch(true);
        throw new Error("Embedded vault did not decrypt under this account's key");
      }
      const msg = new TextEncoder().encode("Signed by the embedded agent wallet");
      let sig: Uint8Array;
      try {
        sig = await embeddedSigner.signMessage(msg);
      } catch (e) {
        setMismatch(true);
        throw e;
      }
      const valid = nacl.sign.detached.verify(msg, sig, new PublicKey(embeddedWallet.publicKey).toBytes());
      setEmbeddedSig({ valid, signature: toBase64(sig) });
      say(valid, `Embedded wallet decrypted & signed ${valid ? "✓" : "FAILED"}`);
    });

  // --- 4. Reveal the embedded private key (fresh Phantom ceremony) ---
  const revealEmbeddedKey = () =>
    run("Reveal embedded key", "reveal", async () => {
      const provider = getInjectedSolana();
      if (!provider || !address) throw new Error("Connect Phantom first");
      if (!embeddedWallet) throw new Error("No embedded wallet on this account");
      // Same hardwareWallet value as login — mixing forms derives a different key.
      await revealEmbedded({ signMessage: makeSignMessage(provider), hardwareWallet: isHardware });
      say(true, "Embedded private key revealed — clears in 60 s");
    });

  const copyKey = () => {
    if (embeddedSecret) navigator.clipboard?.writeText(embeddedSecret);
  };

  const authed = auth.isAuthenticated && !!user;
  const accountTypeLabel =
    accountType === "hardware"
      ? "Ledger-backed"
      : accountType === "software"
        ? "Software"
        : accountType === "unknown"
          ? "Unknown"
          : "Not checked";

  return (
    <main className="page">
      <header className="hero">
        <span className="eyebrow">@tetrac/login-sdk · Phantom + Ledger</span>
        <h1>
          Sign in with <span className="grad">Phantom</span> (Ledger-backed)
        </h1>
        <p>
          The companion to the direct-device page: authenticate through the Phantom extension. When your
          active Phantom account is a <strong>Ledger</strong>, signing flows through to the device — the
          server verifies the off-chain <strong>message</strong> signature and the embedded wallet decrypts
          from the same hardware key.
        </p>
        <div className="trust">
          <Link href="/" className="link">
            ← Back to demo
          </Link>
          <Link href="/ledger" className="link">
            Direct-device (WebUSB) version →
          </Link>
        </div>
      </header>

      <div
        className="card"
        style={{ padding: 14, marginTop: 18, borderColor: "var(--border)", color: "var(--muted)" }}
      >
        ⚠ Needs <strong>Phantom</strong> with a <strong>Ledger account added</strong> (device unlocked, Solana
        app open). Plain software Phantom accounts also work — use “Detect account type” or the toggle.
      </div>

      {mismatch && (
        <div className="gate-error" style={{ marginTop: 14 }}>
          Login succeeded but the embedded vault didn’t decrypt under this account’s key. If this account was
          created on the{" "}
          <Link href="/ledger" className="link">
            direct-device /ledger page
          </Link>
          , sign in there instead — accounts are bound to the path that created them (PRD §8.2).
        </div>
      )}

      <section className="layout" style={{ marginTop: 18 }}>
        <div>
          {/* Step 1 — Connect Phantom */}
          <div className="card" style={{ padding: 20 }}>
            <div className="panel-head">
              <h2>1 · Connect Phantom</h2>
              <p>
                Uses the account already selected in Phantom — no on-device address derivation. Address:{" "}
                <code>{address ? shorten(address) : "—"}</code>
              </p>
            </div>

            {!hasInjected ? (
              <p className="hint" style={{ color: "var(--red)", margin: 0 }}>
                No injected Solana wallet detected. Install Phantom to connect one.
              </p>
            ) : (
              <div className="btn-row" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {!address ? (
                  <button className="btn btn-primary" onClick={connect} disabled={busy === "connect"}>
                    {busy === "connect" ? "Connecting…" : "Connect Phantom"}
                  </button>
                ) : (
                  <>
                    <button
                      className="btn btn-outline"
                      onClick={detectAccountType}
                      disabled={busy === "detect"}
                    >
                      {busy === "detect" ? "Check on device…" : "Detect account type"}
                    </button>
                    <button className="btn btn-outline" onClick={disconnect} disabled={busy === "disconnect"}>
                      Disconnect
                    </button>
                  </>
                )}
              </div>
            )}

            {address && (
              <label
                style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={isHardware}
                  onChange={(e) => {
                    setIsHardware(e.target.checked);
                    setAccountType(null);
                  }}
                />
                <span style={{ fontSize: 13 }}>
                  Treat as hardware wallet (off-chain envelope + newline-free app-key message)
                </span>
              </label>
            )}
          </div>

          {/* Step 2 — Sign in */}
          {address && (
            <div className="card" style={{ padding: 20, marginTop: 16 }}>
              <div className="panel-head">
                <h2>2 · Sign in</h2>
                <p>
                  <code>connectWallet({"{ publicKey, signMessage, hardwareWallet }"})</code> — the same call
                  the software-wallet flow uses. The server accepts the off-chain envelope for hardware
                  accounts.
                </p>
              </div>
              {!authed ? (
                <button className="btn btn-primary" onClick={signIn} disabled={busy === "signin"}>
                  {busy === "signin"
                    ? isHardware
                      ? "Approve 2 prompts on device…"
                      : "Approve in Phantom…"
                    : "Sign in with Phantom"}
                </button>
              ) : (
                <div className="unlocked-tag">✓ Signed in — server accepted the signature.</div>
              )}

              <div style={{ marginTop: 12 }}>
                <button className="btn btn-outline" onClick={signWithProvider} disabled={busy === "devsign"}>
                  {busy === "devsign" ? "Confirm…" : "Test: sign a message"}
                </button>
                {deviceSig && (
                  <div className="sig-result" style={{ marginTop: 10 }}>
                    <div className={`sig-status ${deviceSig.valid ? "ok" : "err"}`}>
                      {deviceSig.valid ? "✓ Signature verified" : "✕ Verification failed"}
                    </div>
                    <code className="sig-bytes">{deviceSig.signature}</code>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 3 — Embedded blob decrypts */}
          {authed && (
            <div className="card" style={{ padding: 20, marginTop: 16 }}>
              <div className="panel-head">
                <h2>3 · Embedded wallet decrypts</h2>
                <p>
                  Generated at sign-up and encrypted under a key derived from your Phantom signature. Signing
                  with it proves the blob unlocks for this account.
                </p>
              </div>
              {embeddedWallet ? (
                <>
                  <div className="wallet-row">
                    <div className="wallet-row-top">
                      <span className="badge badge-sol">SOL</span>
                      <span className="role">{embeddedWallet.role} · agent</span>
                    </div>
                    <code className="key" title={embeddedWallet.publicKey}>
                      {shorten(embeddedWallet.publicKey)}
                    </code>
                  </div>
                  <button
                    className="btn btn-primary"
                    style={{ marginTop: 12 }}
                    onClick={signWithEmbedded}
                    disabled={busy === "embsign" || auth.isLocked}
                  >
                    {auth.isLocked ? "Vault locked" : "Decrypt & sign with embedded wallet"}
                  </button>
                  {embeddedSig && (
                    <div className="sig-result" style={{ marginTop: 10 }}>
                      <div className={`sig-status ${embeddedSig.valid ? "ok" : "err"}`}>
                        {embeddedSig.valid ? "✓ Decrypted & signed" : "✕ Verification failed"}
                      </div>
                      <code className="sig-bytes">{embeddedSig.signature}</code>
                    </div>
                  )}
                </>
              ) : (
                <p style={{ margin: 0, color: "var(--muted)" }}>No embedded wallet on this account.</p>
              )}
            </div>
          )}

          {/* Step 4 — Reveal the plaintext signing key (fresh ceremony) */}
          {authed && embeddedWallet && (
            <div className="card" style={{ padding: 20, marginTop: 16 }}>
              <div className="panel-head">
                <h2>4 · Reveal the private key</h2>
                <p>
                  A separate one-time decrypt: <code>reveal({"{ signMessage, hardwareWallet }"})</code>{" "}
                  re-signs the app-key message through Phantom to derive the decryption key — independent of
                  the vault, so a reveal always costs a fresh approval. Auto-clears after 60 s.
                </p>
              </div>
              <div className="wallet-row">
                <div className="wallet-row-top">
                  <span className="badge badge-sol">SOL</span>
                  <span className="role">{embeddedWallet.role} · agent</span>
                </div>
                <code className="key" title={embeddedWallet.publicKey}>
                  {shorten(embeddedWallet.publicKey)}
                </code>
              </div>

              {!embeddedSecret ? (
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 12 }}
                  onClick={revealEmbeddedKey}
                  disabled={!address || busy === "reveal" || revealLoading}
                >
                  {busy === "reveal" || revealLoading ? "Confirm…" : "Reveal private key (sign to unlock)"}
                </button>
              ) : (
                <div className="secret" style={{ marginTop: 12 }}>
                  <span className="warn">⚠ Private key — never share this.</span>
                  <code>{embeddedSecret}</code>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button className="mini-btn" onClick={copyKey}>
                      Copy
                    </button>
                    <button className="mini-btn danger" onClick={clearEmbedded}>
                      Clear now
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside className="sidebar">
          <div className="card" style={{ padding: 20 }}>
            <h2 className="section-label" style={{ marginTop: 0 }}>
              Session
            </h2>
            <p style={{ margin: 0 }}>
              <strong>status:</strong> {auth.status}
            </p>
            <p style={{ margin: "6px 0 0" }}>
              <strong>account:</strong> {accountTypeLabel}
            </p>
            <p style={{ margin: "6px 0 0", wordBreak: "break-all" }}>
              <strong>publicKey:</strong> {auth.publicKey ?? "—"}
            </p>
            {authed && (
              <button
                type="button"
                className="btn btn-outline"
                style={{ marginTop: 12 }}
                onClick={() => auth.logout()}
              >
                Sign out
              </button>
            )}
          </div>

          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <h2 className="section-label" style={{ marginTop: 0 }}>
              Activity
            </h2>
            {log.length === 0 ? (
              <p style={{ margin: 0, color: "var(--muted)" }}>Connect Phantom to begin.</p>
            ) : (
              <pre className="log">
                {log.map((l, i) => (
                  <div key={i}>
                    <span className={l.ok ? "ok" : "err"}>{l.ok ? "✓" : "✕"}</span> {l.time} {l.msg}
                  </div>
                ))}
              </pre>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}

export default function LedgerPhantomPage() {
  // lockOnHide: false — both the Phantom popup and the on-device confirmation
  // briefly background the tab; with lockOnHide:true the vault would lock before
  // signing returns. walletGen: a single Solana signing agent so there's exactly
  // one embedded blob to demonstrate (Phantom/Ledger is the funds identity).
  return (
    <AuthProvider
      apiBaseUrl="/api/auth"
      config={{ appId: APP_ID, autoLockMs: 120_000, lockOnHide: false }}
      walletGen={{ solana: ["signing"] }}
    >
      <LedgerPhantomInner />
    </AuthProvider>
  );
}
