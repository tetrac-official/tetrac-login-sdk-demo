"use client";

// External-wallet bridge demo.
//
// Wires a connected injected Solana wallet (Phantom & co.) into the SDK via
// <AuthProvider externalSolanaAddress=…>. useActiveWallet() then applies the
// "external connected wins, else embedded funds" rule transparently — the
// rest of the app reads one hook and gets the right wallet for the moment.
//
// The SDK deliberately does NOT depend on @solana/wallet-adapter-react: this
// page subscribes to window.solana / window.phantom.solana directly so the
// pattern works with any injected wallet, no adapter library required.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { AuthProvider, useActiveWallet, useAuth, useSolanaSigner } from "@tetrac/login-sdk/react";
import { LoginPanel, type WalletConnector } from "@tetrac/login-sdk/ui";
import { Mail, Wallet, Fingerprint } from "lucide-react";
import type { PasskeyRegistration } from "@tetrac/login-sdk/client";

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

const PASSKEY_STORAGE_KEY = "ttc-demo-passkey-reg";

// The wallet connector the SDK's <LoginPanel> calls — same glue as the /ui page.
const solanaConnector: WalletConnector = {
  label: "Continue with Solana wallet",
  connect: async () => {
    const provider = getInjectedSolana();
    if (!provider) throw new Error("No Solana wallet detected (install Phantom?)");
    await provider.connect();
    if (!provider.publicKey) throw new Error("Wallet connection did not return a public key");
    const publicKey = provider.publicKey.toString();
    const signMessage = async (m: Uint8Array): Promise<Uint8Array> => {
      const sig = await provider.signMessage(m, "utf8");
      return sig instanceof Uint8Array ? sig : sig.signature;
    };
    return { publicKey, signMessage };
  },
};

/**
 * The bridge itself: subscribe to the injected wallet's connect/disconnect
 * events and pipe the current public key into <AuthProvider>. That's it —
 * the SDK reads the prop reactively and useActiveWallet() reacts in turn.
 */
function BridgeAuthProvider({ children }: { children: React.ReactNode }) {
  const [externalAddress, setExternalAddress] = useState<string | null>(null);

  useEffect(() => {
    const provider = getInjectedSolana();
    if (!provider) return;

    // Pick up an already-connected wallet on mount (e.g. after a page reload
    // where Phantom restored its session).
    if (provider.publicKey) setExternalAddress(provider.publicKey.toString());

    const onConnect = () => {
      const pk = provider.publicKey?.toString();
      setExternalAddress(pk ?? null);
    };
    const onDisconnect = () => setExternalAddress(null);

    provider.on?.("connect", onConnect);
    provider.on?.("disconnect", onDisconnect);
    return () => {
      // Phantom uses removeListener on older versions; try both.
      provider.off?.("connect", onConnect);
      provider.off?.("disconnect", onDisconnect);
      provider.removeListener?.("connect", onConnect);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, []);

  return (
    <AuthProvider apiBaseUrl="/api/auth" externalSolanaAddress={externalAddress}>
      {children}
    </AuthProvider>
  );
}

type LogLine = { ok: boolean; msg: string; time: string };

function BridgePageInner() {
  const auth = useAuth();
  const active = useActiveWallet();
  // useSolanaSigner returns null when active.encrypted is null (external wallets)
  // OR when the session is locked. The signing handler routes accordingly.
  const embeddedSigner = useSolanaSigner(active?.encrypted ?? null);

  const [message, setMessage] = useState("Hello from the external-wallet bridge");
  const [busy, setBusy] = useState(false);
  const [signResult, setSignResult] = useState<{
    via: string;
    address: string;
    sig: string;
    valid: boolean;
  } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [passkeyReg, setPasskeyReg] = useState<PasskeyRegistration | null>(null);

  const say = (ok: boolean, msg: string) =>
    setLog((l) => [{ ok, msg, time: new Date().toLocaleTimeString() }, ...l]);

  // Restore a cached biometric registration so returning visitors get "Unlock".
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(PASSKEY_STORAGE_KEY);
    if (raw) {
      try {
        setPasskeyReg(JSON.parse(raw) as PasskeyRegistration);
      } catch {
        window.localStorage.removeItem(PASSKEY_STORAGE_KEY);
      }
    }
  }, []);

  const onPasskeyRegistered = (reg: PasskeyRegistration) => {
    window.localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(reg));
    setPasskeyReg(reg);
  };

  // The injected wallet might not exist (no Phantom installed); guard once for
  // the entire UI so we can show a friendly hint.
  const hasInjected = typeof window !== "undefined" && !!getInjectedSolana();

  const connectExternal = useCallback(async () => {
    setBusy(true);
    try {
      const provider = getInjectedSolana();
      if (!provider) throw new Error("No Solana wallet detected — install Phantom.");
      await provider.connect();
      // The actual address state is set by the BridgeAuthProvider's event listener.
      say(true, `External wallet connected — ${shorten(provider.publicKey?.toString() ?? "")}`);
    } catch (e) {
      say(false, `Connect — ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnectExternal = useCallback(async () => {
    const provider = getInjectedSolana();
    if (!provider) return;
    try {
      await provider.disconnect();
      say(true, "External wallet disconnected");
    } catch (e) {
      say(false, `Disconnect — ${(e as Error).message}`);
    }
  }, []);

  async function signMessage() {
    setSignResult(null);
    if (!active) {
      say(false, "No active wallet — connect external or sign in for embedded.");
      return;
    }
    const msgBytes = new TextEncoder().encode(message);
    setBusy(true);
    try {
      if (active.isEmbedded) {
        // Embedded path: the SDK owns the key. Decrypt-on-demand via the signer hook.
        if (!embeddedSigner) throw new Error("Embedded signer unavailable (session locked).");
        const sig = await embeddedSigner.signMessage(msgBytes);
        const valid = nacl.sign.detached.verify(msgBytes, sig, new PublicKey(active.address).toBytes());
        setSignResult({
          via: "embedded (useSolanaSigner)",
          address: active.address,
          sig: toBase64(sig),
          valid,
        });
        say(true, `Signed via embedded signer · ${valid ? "verified" : "INVALID"}`);
      } else {
        // External path: the SDK only knows the address; the key lives in the wallet.
        // Route the signing call through the injected provider.
        const provider = getInjectedSolana();
        if (!provider) throw new Error("External provider unavailable.");
        const res = await provider.signMessage(msgBytes, "utf8");
        const sig = res instanceof Uint8Array ? res : res.signature;
        const valid = nacl.sign.detached.verify(msgBytes, sig, new PublicKey(active.address).toBytes());
        setSignResult({
          via: "external (injected adapter)",
          address: active.address,
          sig: toBase64(sig),
          valid,
        });
        say(true, `Signed via external wallet · ${valid ? "verified" : "INVALID"}`);
      }
    } catch (e) {
      say(false, `Sign — ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <header className="hero">
        <span className="eyebrow">externalSolanaAddress · the wins rule</span>
        <h1>
          Bring your <span className="grad">own wallet.</span>
        </h1>
        <p>
          When a user connects Phantom (or any injected Solana wallet), <code>useActiveWallet()</code> returns
          that wallet instead of the embedded one. Disconnect and it falls back to the embedded funds key. One
          hook, the right wallet at every moment — and the SDK never imports a specific wallet adapter
          library.
        </p>
        <div className="trust">
          <Link href="/" className="link">
            ← Back to demo
          </Link>
        </div>
      </header>

      <section className="layout" style={{ marginTop: 24 }}>
        <div>
          {/* Active wallet — one card. Shows the current wallet (badge + address)
              and the connect/disconnect control together, so there's a single
              place to reason about "which wallet am I using right now". */}
          <div className="card" style={{ padding: 20, marginBottom: 14 }}>
            <div className="tags">
              <span className="tag tag-sdk">useActiveWallet()</span>
              <span className="tag tag-custom">Phantom wiring</span>
            </div>
            <div className="panel-head">
              <h2>Active wallet</h2>
              <p>
                Computed by <code>useActiveWallet()</code> — a connected external wallet wins, otherwise the
                embedded Solana funds key.
              </p>
            </div>

            {active ? (
              <div className="signing-as" style={{ marginTop: 8 }}>
                <span
                  className={`badge ${active.isEmbedded ? "badge-sol" : "badge-evm"}`}
                  style={{ marginRight: 8 }}
                >
                  {active.isEmbedded ? "EMBEDDED" : "EXTERNAL"}
                </span>
                <code title={active.address}>{shorten(active.address)}</code> <small>· {active.role}</small>
              </div>
            ) : (
              <div className="log-empty">
                No active wallet. Connect an external wallet or sign in below to mint an embedded one.
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              {!hasInjected ? (
                <p className="hint" style={{ color: "var(--red)" }}>
                  No injected Solana wallet detected. Install Phantom to connect one.
                </p>
              ) : active && !active.isEmbedded ? (
                <button className="sdk-btn" onClick={disconnectExternal} disabled={busy}>
                  Disconnect wallet
                </button>
              ) : (
                <button className="sdk-btn" onClick={connectExternal} disabled={busy}>
                  Connect wallet
                </button>
              )}
            </div>
          </div>

          {/* The SDK's own <LoginPanel> — the exact same component as the /ui page:
              its own "Log in or sign up" heading and all three methods. No custom
              wrapper, no stripped-down email-only variant. */}
          <div className="card" style={{ padding: 20, marginBottom: 14 }}>
            <div className="tags">
              <span className="tag tag-sdk">&lt;LoginPanel /&gt;</span>
            </div>
            <LoginPanel
              methods={["email", "wallet", "biometric"]}
              emailMode="auto"
              walletConnector={solanaConnector}
              passkeyRegistration={passkeyReg}
              onPasskeyRegistered={onPasskeyRegistered}
              biometricUserName="bridge@tetrac.local"
              title="Log in or sign up"
              icons={{
                email: <Mail size={18} />,
                wallet: <Wallet size={18} />,
                biometric: <Fingerprint size={18} />,
              }}
              appearance={{ radius: 14 }}
              onSuccess={(r, m) => say(true, `${m} — ${shorten(r.publicKey)}`)}
              onError={(e, m) => say(false, `${m} — ${e.message}`)}
              styles={{
                root: { color: "var(--fg)", maxWidth: "100%" },
                title: { color: "var(--fg)" },
                input: {
                  background: "var(--elevated)",
                  color: "var(--fg)",
                  border: "1px solid var(--border)",
                },
                button: {
                  background: "transparent",
                  color: "var(--fg)",
                  border: "1px solid var(--border)",
                },
                primaryButton: {
                  background: "transparent",
                  color: "var(--fg)",
                  border: "1px solid var(--border)",
                },
                iconWrap: { border: "1px solid var(--border)", color: "var(--fg)" },
                error: { color: "var(--red)" },
                muted: { color: "var(--muted)" },
              }}
            />
            {auth.isAuthenticated ? (
              <button className="sdk-btn" style={{ marginTop: 12 }} onClick={auth.logout}>
                Sign out
              </button>
            ) : null}
          </div>

          {/* Sign a message — the same UI works for both wallet types, routed
              by `active.isEmbedded`. */}
          <div className="card sign-card">
            <div className="tags">
              <span className="tag tag-sdk">useSolanaSigner</span>
              <span className="tag tag-custom">UI + tweetnacl verify</span>
            </div>
            <div className="panel-head">
              <h2>Sign with the active wallet</h2>
              <p>
                One button, two code paths. Embedded → <code>useSolanaSigner</code>; external → the injected
                provider directly. Verification is local with <code>tweetnacl</code>.
              </p>
            </div>
            <textarea
              className="sdk-field sdk-textarea"
              style={{ marginBottom: 12 }}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
            />
            <button className="sdk-btn" onClick={signMessage} disabled={!active || !message.trim() || busy}>
              {busy ? "Signing…" : "Sign message"}
            </button>
            {signResult ? (
              <div className="sig-result">
                <div className={`sig-status ${signResult.valid ? "ok" : "err"}`}>
                  {signResult.valid ? "✓ Verified locally" : "✕ Verification failed"}
                </div>
                <div className="sig-meta">
                  Via: <code>{signResult.via}</code>
                </div>
                <div className="sig-meta">
                  From: <code title={signResult.address}>{shorten(signResult.address)}</code>
                </div>
                <code className="sig-bytes">{signResult.sig}</code>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="sidebar">
          <div className="card status">
            <div className="status-main">
              <span className={`dot ${active ? "on" : "off"}`} />
              <div style={{ minWidth: 0 }}>
                <div className="status-title">
                  {active
                    ? active.isEmbedded
                      ? "Embedded wallet active"
                      : "External wallet active"
                    : "No active wallet"}
                </div>
                <div className="status-sub">{active ? shorten(active.address) : "—"}</div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="activity-head">
              <h3>Activity</h3>
              <span>bridge events</span>
            </div>
            {log.length === 0 ? (
              <div className="log-empty">Connect a wallet or sign in — every state change lands here.</div>
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

      {/* What the SDK gives you vs. what this page hand-builds. The bridge route
          uses NO SDK UI components — that contrast with /ui is the whole point. */}
      <section style={{ marginTop: 32 }}>
        <div className="section-head">
          <p className="kicker">SDK UI + headless hooks</p>
          <h2>
            What&apos;s the SDK, and what&apos;s <span className="grad">this page?</span>
          </h2>
          <p className="section-sub">
            The embedded sign-in is the SDK&apos;s prebuilt <code>&lt;LoginPanel /&gt;</code> — the same
            component the{" "}
            <Link href="/ui" className="link">
              /ui
            </Link>{" "}
            page uses. The wallet bridge and signing stay custom UI on top of headless hooks, but reuse the
            SDK&apos;s flat button/input styling so everything reads the same.
          </p>
        </div>

        <div className="two-col">
          <div className="card" style={{ padding: 20 }}>
            <div className="tags">
              <span className="tag tag-sdk">SDK</span>
            </div>
            <h3>From @tetrac/login-sdk</h3>
            <ul className="feature-list sdk">
              <li>
                <span>
                  <code>&lt;LoginPanel /&gt;</code> — the full sign-in panel (email, wallet, biometric), same
                  as the /ui page
                </span>
              </li>
              <li>
                <span>
                  <code>&lt;AuthProvider externalSolanaAddress /&gt;</code> — pipes the connected address in
                </span>
              </li>
              <li>
                <span>
                  <code>useActiveWallet()</code> — the “external wins, else embedded” rule
                </span>
              </li>
              <li>
                <span>
                  <code>useAuth()</code> — session status and sign-out
                </span>
              </li>
              <li>
                <span>
                  <code>useSolanaSigner()</code> — decrypt-on-demand signing for the embedded key
                </span>
              </li>
            </ul>
          </div>

          <div className="card" style={{ padding: 20 }}>
            <div className="tags">
              <span className="tag tag-custom">This page</span>
            </div>
            <h3>Built in this demo</h3>
            <ul className="feature-list">
              <li>
                <span>
                  <code>window.solana</code> / Phantom connect + event subscription
                </span>
              </li>
              <li>
                <span>Connect / disconnect buttons and the active-wallet card</span>
              </li>
              <li>
                <span>The sign-message UI (routes embedded vs external)</span>
              </li>
              <li>
                <span>
                  Local signature verification with <code>tweetnacl</code>
                </span>
              </li>
              <li>
                <span>The activity log</span>
              </li>
              <li>
                <span>
                  …all reusing the SDK&apos;s flat styling (<code>.sdk-btn</code> / <code>.sdk-field</code>)
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}

export default function BridgePage() {
  // The BridgeAuthProvider replaces the root <Providers> for this route: it
  // wires the wallet-adapter address into the SDK provider. Other routes can
  // keep using the plain <AuthProvider> in app/providers.tsx.
  return (
    <BridgeAuthProvider>
      <BridgePageInner />
    </BridgeAuthProvider>
  );
}

// --- helpers ---
function shorten(key: string): string {
  return key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key;
}
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
