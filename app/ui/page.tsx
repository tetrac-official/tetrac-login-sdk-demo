"use client";

// Showcase page for the optional UI package shipped at @tetrac/login-sdk/ui.
// The headless `/api/auth` routes and the `<AuthProvider>` (wired in
// app/providers.tsx) do all the heavy lifting — this page only renders the
// SDK-supplied <LoginPanel> and hands it a wallet connector + the cached
// passkey registration.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Providers } from "../providers";
import { LoginPanel, type WalletConnector } from "@tetrac/login-sdk/ui";
import { useAuth } from "@tetrac/login-sdk/react";
import type { PasskeyRegistration } from "@tetrac/login-sdk/client";
import type { AuthResult } from "@tetrac/login-sdk/core";

const PASSKEY_STORAGE_KEY = "ttc-demo-passkey-reg";

// Injected Solana wallet shape (Phantom & co.) — mirrors DemoShell.tsx so we
// stay decoupled from `@solana/wallet-adapter-react` for this skeleton.
type InjectedSolana = {
  connect: () => Promise<unknown>;
  publicKey?: { toString(): string };
  signMessage: (m: Uint8Array, display?: string) => Promise<{ signature: Uint8Array } | Uint8Array>;
};

function getInjectedSolana(): InjectedSolana | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { solana?: InjectedSolana; phantom?: { solana?: InjectedSolana } };
  return w.phantom?.solana ?? w.solana ?? null;
}

// Build a WalletConnector the SDK's <LoginPanel> can call. The SDK never
// touches a specific wallet library — the app supplies this glue.
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
      // Phantom returns { signature }, some wallets return the raw Uint8Array.
      return sig instanceof Uint8Array ? sig : sig.signature;
    };
    return { publicKey, signMessage };
  },
};

function UIPageInner() {
  const { status, publicKey, email, logout } = useAuth();
  const [passkeyReg, setPasskeyReg] = useState<PasskeyRegistration | null>(null);
  const [lastResult, setLastResult] = useState<{ method: string; publicKey: string } | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  // Restore biometric registration so returning visitors get the "Unlock" path.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(PASSKEY_STORAGE_KEY);
    if (raw) {
      try {
        setPasskeyReg(JSON.parse(raw) as PasskeyRegistration);
      } catch {
        // Corrupt blob — drop it so the user can re-enroll.
        window.localStorage.removeItem(PASSKEY_STORAGE_KEY);
      }
    }
  }, []);

  const onSuccess = (result: AuthResult, method: string) => {
    setLastError(null);
    setLastResult({ method, publicKey: result.publicKey });
  };
  const onError = (err: Error, method: string) => {
    setLastError(`${method}: ${err.message}`);
  };

  const onPasskeyRegistered = (reg: PasskeyRegistration) => {
    window.localStorage.setItem(PASSKEY_STORAGE_KEY, JSON.stringify(reg));
    setPasskeyReg(reg);
  };

  return (
    <main className="page">
      <header className="hero">
        <span className="eyebrow">@tetrac/login-sdk/ui</span>
        <h1>
          Drop-in <span className="grad">login panel</span>
        </h1>
        <p>
          The whole sign-in surface below is a single <code>&lt;LoginPanel /&gt;</code> from the SDK&apos;s
          optional <code>/ui</code> entry. No wallet adapter library, no custom forms — the demo just
          passes a connector and a passkey-registration callback.
        </p>
        <div className="trust">
          <Link href="/" className="link">
            ← Back to the headless demo
          </Link>
        </div>
      </header>

      <section className="layout" style={{ marginTop: 24 }}>
        <div className="card" style={{ padding: 20 }}>
          <h2 className="section-label" style={{ marginTop: 0 }}>
            Login Panel
          </h2>

          {/* The SDK component. Themed via `appearance` + `classNames` so it
              picks up the demo's brand tokens without us hand-rolling a form. */}
          <LoginPanel
            methods={["email", "wallet", "biometric"]}
            emailMode="auto"
            walletConnector={solanaConnector}
            passkeyRegistration={passkeyReg}
            onPasskeyRegistered={onPasskeyRegistered}
            biometricUserName="ui-demo@tetrac.local"
            onSuccess={onSuccess}
            onError={onError}
            appearance={{ accent: "#3a479e", radius: 10 }}
            // Per-slot inline overrides: dark-theme the panel using the demo's
            // brand tokens. The SDK merges these on top of its defaults, so we
            // only have to list what we want to change.
            styles={{
              root: { color: "var(--fg)", maxWidth: "100%", gap: 18 },
              title: { color: "var(--fg)" },
              methodLabel: { color: "var(--muted)" },
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
                background: "var(--brand-gradient)",
                color: "#fff",
                border: "none",
              },
              divider: { borderTop: "1px solid var(--border)" },
              error: { color: "var(--red)" },
              muted: { color: "var(--muted)" },
            }}
          />
        </div>

        <aside className="sidebar">
          <div className="card" style={{ padding: 20 }}>
            <h2 className="section-label" style={{ marginTop: 0 }}>
              Session
            </h2>
            <p style={{ margin: 0 }}>
              <strong>status:</strong> {status}
            </p>
            <p style={{ margin: "6px 0 0" }}>
              <strong>email:</strong> {email ?? "—"}
            </p>
            <p style={{ margin: "6px 0 0", wordBreak: "break-all" }}>
              <strong>publicKey:</strong> {publicKey ?? "—"}
            </p>
            {status === "authenticated" ? (
              <button type="button" className="btn btn-outline" style={{ marginTop: 12 }} onClick={logout}>
                Sign out
              </button>
            ) : null}
          </div>

          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <h2 className="section-label" style={{ marginTop: 0 }}>
              Last event
            </h2>
            {lastResult ? (
              <p style={{ margin: 0 }}>
                ✅ <strong>{lastResult.method}</strong> →{" "}
                <span style={{ wordBreak: "break-all" }}>{lastResult.publicKey}</span>
              </p>
            ) : (
              <p style={{ margin: 0, color: "var(--muted)" }}>No login yet.</p>
            )}
            {lastError ? (
              <p style={{ margin: "8px 0 0", color: "var(--red)" }}>⚠ {lastError}</p>
            ) : null}
          </div>
        </aside>
      </section>
    </main>
  );
}

export default function UIPage() {
  // Wrap in <Providers> so this route works standalone if the user lands on it
  // before the root page has mounted the AuthProvider tree.
  return (
    <Providers>
      <UIPageInner />
    </Providers>
  );
}
