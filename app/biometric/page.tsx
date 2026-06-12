"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  AuthProvider,
  useAuth,
  useAuthContext,
  useWallets,
  useBiometricUnlock,
  useSolanaSigner,
  useExportKey,
  type ReauthCredentials,
  type WalletEntry,
} from "@tetrac/login-sdk/react";
import type { PasskeyRegistration } from "@tetrac/login-sdk/client";
import { APP_ID } from "../lib/appConfig";
import { FingerprintIcon, MailIcon, ShieldIcon, WalletIcon } from "../components/icons";

const BIO_UNLOCK_KEY = "ttc-demo-bio-unlock-reg";

type LogLine = { ok: boolean; msg: string; ts: string };
type InjectedSolana = {
  connect: () => Promise<unknown>;
  publicKey?: { toString(): string };
  signMessage: (m: Uint8Array, enc?: string) => Promise<{ signature: Uint8Array } | Uint8Array>;
};

function getInjectedSolana(): InjectedSolana | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    solana?: InjectedSolana;
    phantom?: { solana?: InjectedSolana };
  };
  return w.phantom?.solana ?? w.solana ?? null;
}

function toHex(b: Uint8Array) {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

// ── Inner page (must be inside AuthProvider) ────────────────────────────────

function BiometricPageInner() {
  const auth = useAuth();
  const { client } = useAuthContext();
  const wallets = useWallets();
  const bioUnlock = useBiometricUnlock();

  // Auth form state
  const [email, setEmail] = useState("alice@example.com");
  const [passkey, setPasskey] = useState("correct horse battery staple");
  const [bioReg, setBioReg] = useState<PasskeyRegistration | null>(null);
  const walletSigner = useRef<{
    publicKey: string;
    signMessage: (m: Uint8Array) => Promise<Uint8Array>;
  } | null>(null);

  // Biometric unlock registration — saved here so reveal({ biometricUnlock: reg })
  // can use it. The hook's unlock() reads from IndexedDB independently.
  const [bioUnlockReg, setBioUnlockReg] = useState<PasskeyRegistration | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(BIO_UNLOCK_KEY);
      return raw ? (JSON.parse(raw) as PasskeyRegistration) : null;
    } catch {
      return null;
    }
  });
  const [enabling, setEnabling] = useState(false);

  // Message signing
  const [message, setMessage] = useState("Hello from biometric vault");
  const [sigResult, setSigResult] = useState<{
    sig: string;
    valid: boolean;
  } | null>(null);
  const [sigError, setSigError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  // Activity log
  const [log, setLog] = useState<LogLine[]>([]);

  // SDK-resolved signer — null when vault is locked, populated when unlocked.
  // Drives both the "Sign" section and the vault-state indicator.
  const solanaEntry: WalletEntry | undefined = wallets.find(
    (w) => w.chain === "solana" && w.isEmbedded && w.encrypted,
  );
  const solanaSigner = useSolanaSigner(solanaEntry?.encrypted ?? null);

  // Key reveal via biometric ceremony (one-time decrypt, vault state irrelevant).
  const {
    reveal,
    clear,
    plaintext,
    loading: revealLoading,
    error: revealError,
  } = useExportKey(solanaEntry?.encrypted ?? null, { autoClearMs: 30_000 });

  const say = (ok: boolean, msg: string) =>
    setLog((l) => [{ ok, msg, ts: new Date().toLocaleTimeString() }, ...l.slice(0, 29)]);

  async function track<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const r = await fn();
      say(true, `${label} — ok`);
      return r;
    } catch (e) {
      say(false, `${label} — ${(e as Error).message}`);
      return null;
    }
  }

  // ── 1. Auth methods ────────────────────────────────────────────────────────

  const emailRegister = () => track("Email register", () => auth.registerWithEmail({ email, passkey }));
  const emailLogin = () => track("Email sign-in", () => auth.loginWithEmail({ email, passkey }));

  const walletConnect = async () => {
    const provider = getInjectedSolana();
    let signer: typeof walletSigner.current;
    if (provider) {
      try {
        await provider.connect();
      } catch {
        return say(false, "Wallet — connection rejected");
      }
      const pk = provider.publicKey?.toString();
      if (!pk) return say(false, "Wallet — no public key");
      signer = {
        publicKey: pk,
        signMessage: async (m) => {
          const res = await provider.signMessage(m, "utf8");
          return res instanceof Uint8Array ? res : res.signature;
        },
      };
    } else {
      const kp = Keypair.generate();
      signer = {
        publicKey: kp.publicKey.toBase58(),
        signMessage: async (m) => nacl.sign.detached(m, kp.secretKey),
      };
      say(true, "No wallet installed — using a simulated keypair");
    }
    walletSigner.current = signer;
    await track("Wallet sign-in", () => auth.connectWallet(signer!));
  };

  const bioRegister = async () => {
    const r = await track("Biometric register", () =>
      auth.registerWithBiometric({ userName: "bio-demo-user" }),
    );
    if (r) setBioReg(r.registration);
  };
  const bioLogin = async () => {
    if (!bioReg) return say(false, "Biometric login — set up biometric first");
    await track("Biometric sign-in", () => auth.loginWithBiometric({ registration: bioReg }));
  };

  // ── 2. Enable biometric unlock ────────────────────────────────────────────

  const enableBioUnlock = async () => {
    setEnabling(true);
    try {
      // Must use client directly — the hook's enable() returns void so we can't
      // recover the PasskeyRegistration needed for reveal({ biometricUnlock: reg }).
      const reg = await client.enableBiometricUnlock("ttc-demo-user");
      window.localStorage.setItem(BIO_UNLOCK_KEY, JSON.stringify(reg));
      setBioUnlockReg(reg);
      say(true, "Biometric unlock enabled");
    } catch (e) {
      say(false, `Enable bio unlock — ${(e as Error).message}`);
    } finally {
      setEnabling(false);
    }
  };

  const disableBioUnlock = async () => {
    if (!bioUnlockReg) return;
    try {
      await client.disableBiometricUnlock(bioUnlockReg);
      window.localStorage.removeItem(BIO_UNLOCK_KEY);
      setBioUnlockReg(null);
      setSigResult(null);
      clear();
      say(true, "Biometric unlock removed");
    } catch (e) {
      say(false, `Remove bio unlock — ${(e as Error).message}`);
    }
  };

  // ── 3. Vault lock / biometric re-arm ─────────────────────────────────────

  const lockVault = () => {
    auth.lock();
    setSigResult(null);
    say(true, "Vault locked — solanaSigner is now null");
  };

  const unlockWithBiometric = async () => {
    if (!bioUnlockReg) return say(false, "Unlock — no registration saved");
    say(true, "Unlock — requesting Touch ID / Face ID…");
    // client.unlockViaBiometric is the direct path: Touch ID → unwrap stored app
    // key → re-arm vault. auth.reauthenticate({ biometricUnlock }) goes through
    // the general re-auth path which can short-circuit on consecutive unlocks.
    await track("Biometric vault re-arm", () => client.unlockViaBiometric(bioUnlockReg));
    // useSolanaSigner re-renders non-null automatically once the vault is armed.
  };

  // ── 4. Sign a message using the armed vault ───────────────────────────────

  const signMessage = async () => {
    if (!solanaSigner) return;
    setSigning(true);
    setSigError(null);
    setSigResult(null);
    try {
      const msgBytes = new TextEncoder().encode(message);
      const sig = await solanaSigner.signMessage(msgBytes);
      const valid = nacl.sign.detached.verify(msgBytes, sig, solanaSigner.publicKey.toBytes());
      setSigResult({ sig: toHex(sig).slice(0, 32) + "…", valid });
      say(true, `Signed — verify: ${valid}`);
    } catch (e) {
      setSigError((e as Error).message);
      say(false, `Sign — ${(e as Error).message}`);
    } finally {
      setSigning(false);
    }
  };

  // ── 5. Reveal private key (one-time biometric decrypt) ───────────────────

  const revealWithBiometric = async () => {
    if (!bioUnlockReg) return;
    const creds: ReauthCredentials = { biometricUnlock: bioUnlockReg };
    try {
      await reveal(creds);
      say(true, "Key revealed — auto-clears in 30 s");
    } catch (e) {
      say(false, `Reveal — ${(e as Error).message}`);
    }
  };

  // ── Derived display state ─────────────────────────────────────────────────

  const hasAccount = auth.hasAccount;
  const bioEnabled = bioUnlock.isEnabled || !!bioUnlockReg;
  const vaultUnlocked = hasAccount && !auth.isLocked;

  return (
    <main className="page">
      {/* ── Header ── */}
      <header className="hero">
        <span className="eyebrow">v0.3.0 · useBiometricUnlock</span>
        <h1>
          Biometric unlock <span className="grad">for any account</span>
        </h1>
        <p>
          Wrap any account&apos;s in-memory app key under a platform passkey so future vault locks clear with
          one touch. Works for email, wallet, and biometric-primary accounts. Two independent paths: vault
          re-arm (enables signing) and one-time key reveal.
        </p>
        <div className="trust">
          <Link href="/" className="link">
            ← Back to demo
          </Link>
          <span> · </span>
          <Link href="/ui" className="link">
            UI panel →
          </Link>
        </div>
      </header>

      <div className="layout">
        <section>
          {/* ── Step 1: Auth methods ──────────────────────────────────── */}
          <div className="section-label">
            {hasAccount ? "Signed in — switch account below" : "Step 1 — sign in"}
          </div>

          <div className="methods">
            <div className="card method">
              <div className="method-head">
                <div className="icon-chip">
                  <MailIcon />
                </div>
                <div>
                  <p className="method-title">Email &amp; passkey</p>
                  <p className="method-desc">Sign in, then add biometric unlock on top.</p>
                </div>
              </div>
              <div className="method-body">
                <div className="field-row">
                  <input
                    className="input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                  <input
                    className="input"
                    type="password"
                    value={passkey}
                    onChange={(e) => setPasskey(e.target.value)}
                    placeholder="passkey"
                  />
                </div>
                <button className="btn btn-primary" onClick={emailRegister}>
                  Create account
                </button>
                <button className="link" onClick={emailLogin}>
                  Sign in
                </button>
              </div>
            </div>

            <div className="card method">
              <div className="method-head">
                <div className="icon-chip">
                  <WalletIcon />
                </div>
                <div>
                  <p className="method-title">Crypto wallet</p>
                  <p className="method-desc">Phantom or a simulated keypair.</p>
                </div>
              </div>
              <div className="method-body">
                <button className="btn btn-primary" onClick={walletConnect}>
                  Continue with wallet
                </button>
                <p className="hint">No wallet? A simulated key is used.</p>
              </div>
            </div>

            <div className="card method">
              <div className="method-head">
                <div className="icon-chip">
                  <FingerprintIcon />
                </div>
                <div>
                  <p className="method-title">Biometric primary</p>
                  <p className="method-desc">PRF passkey as the primary auth factor.</p>
                </div>
              </div>
              <div className="method-body">
                <div className="btn-row">
                  <button className="btn btn-primary" onClick={bioRegister}>
                    Set up
                  </button>
                  <button className="btn btn-outline" onClick={bioLogin}>
                    Sign in
                  </button>
                </div>
                <p className="hint">Requires Face ID / Touch ID.</p>
              </div>
            </div>
          </div>

          {/* ── Step 2: Enable biometric unlock ──────────────────────── */}
          {hasAccount && (
            <>
              <div className="section-label" style={{ marginTop: 28 }}>
                Step 2 — enable biometric unlock
              </div>
              <div className="card">
                <p style={{ margin: "0 0 12px", color: "var(--muted)", fontSize: 13 }}>
                  Wraps your current app key under a Touch ID / Face ID passkey. The raw key never leaves the
                  device — only an encrypted blob is stored in IndexedDB. Vault must be unlocked to enroll.
                </p>

                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className={`dot ${bioUnlock.available ? "on" : "off"}`} />
                  <span style={{ color: "var(--muted)", fontSize: 13 }}>
                    {bioUnlock.available
                      ? "Touch ID / Face ID available"
                      : "Not supported on this device / browser"}
                  </span>
                </div>

                {bioUnlock.available && (
                  <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {bioEnabled ? (
                      <>
                        <span className="unlocked-tag">
                          <ShieldIcon /> Biometric unlock active
                        </span>
                        <button
                          className="btn btn-outline"
                          style={{ color: "var(--red)", borderColor: "var(--red)" }}
                          onClick={disableBioUnlock}
                          disabled={bioUnlock.loading}
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-primary"
                        onClick={enableBioUnlock}
                        disabled={enabling || bioUnlock.loading || !vaultUnlocked}
                        title={!vaultUnlocked ? "Re-authenticate to unlock the vault first" : undefined}
                      >
                        {enabling ? "Enrolling…" : "Enable biometric unlock"}
                      </button>
                    )}
                    {!vaultUnlocked && !bioEnabled && (
                      <p className="hint" style={{ margin: "8px 0 0", width: "100%" }}>
                        Vault is locked — re-authenticate to enroll.
                      </p>
                    )}
                  </div>
                )}

                {bioUnlock.error && (
                  <div className="gate-error" style={{ marginTop: 8 }}>
                    {bioUnlock.error.message}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Step 3: Lock vault & re-arm via biometric ────────────── */}
          {bioEnabled && (
            <>
              <div className="section-label" style={{ marginTop: 28 }}>
                Step 3 — lock vault, then re-arm with biometric
              </div>
              <div className="card">
                <p style={{ margin: "0 0 12px", color: "var(--muted)", fontSize: 13 }}>
                  Lock the vault to simulate an auto-lock timeout. Then unlock with Touch ID / Face ID — when
                  it succeeds, <code>useSolanaSigner</code> goes from{" "}
                  <code style={{ color: "var(--red)" }}>null</code> →{" "}
                  <code style={{ color: "var(--green, #4ade80)" }}>SolanaSigner</code> and the sign section
                  below becomes active.
                </p>

                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 10px",
                      background: "var(--elevated)",
                      border: "1px solid var(--border)",
                      borderRadius: 7,
                      fontSize: 13,
                    }}
                  >
                    <span className={`dot ${solanaSigner ? "on" : "off"}`} />
                    <code>solanaSigner</code>
                    <span style={{ color: "var(--muted)" }}>
                      {solanaSigner ? "= SolanaSigner ✓" : "= null"}
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  <button className="btn btn-outline" onClick={lockVault} disabled={!vaultUnlocked}>
                    Lock vault now
                  </button>
                  <button className="btn btn-primary" onClick={unlockWithBiometric} disabled={vaultUnlocked}>
                    Unlock with biometric
                  </button>
                </div>

                {bioUnlock.error && (
                  <div className="gate-error" style={{ marginTop: 8 }}>
                    {bioUnlock.error.message}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Step 4: Sign a message ────────────────────────────────── */}
          {bioEnabled && (
            <>
              <div className="section-label" style={{ marginTop: 28 }}>
                Step 4 — sign a message with the unlocked vault
              </div>
              <div className="card">
                <p style={{ margin: "0 0 12px", color: "var(--muted)", fontSize: 13 }}>
                  Proves <code>bioUnlock.unlock()</code> truly armed the vault. The SDK signs using the
                  in-memory app key — no passkey or wallet prompt here.
                </p>

                <div className="field-row">
                  <input
                    className="input"
                    type="text"
                    value={message}
                    onChange={(e) => {
                      setMessage(e.target.value);
                      setSigResult(null);
                    }}
                    placeholder="Message to sign"
                  />
                </div>

                <button
                  className="btn btn-primary"
                  style={{ marginTop: 10 }}
                  onClick={signMessage}
                  disabled={signing || !solanaSigner}
                  title={!solanaSigner ? "Unlock the vault first (Step 3)" : undefined}
                >
                  {signing
                    ? "Signing…"
                    : !solanaSigner
                      ? "Sign (unlock vault first)"
                      : "Sign with unlocked vault"}
                </button>

                {sigResult && (
                  <div className="sig-result" style={{ marginTop: 12 }}>
                    <div className={`sig-status ${sigResult.valid ? "ok" : "err"}`}>
                      {sigResult.valid ? "✓ Signature valid" : "✕ Invalid"}
                    </div>
                    <div className="sig-meta">
                      <span className="sig-bytes">{sigResult.sig}</span>
                    </div>
                  </div>
                )}

                {sigError && (
                  <div className="gate-error" style={{ marginTop: 8 }}>
                    {sigError}
                  </div>
                )}

                {!solanaSigner && !auth.isLocked && !solanaEntry && (
                  <p className="hint" style={{ marginTop: 8 }}>
                    No embedded Solana wallet on this account yet.
                  </p>
                )}
              </div>
            </>
          )}

          {/* ── Step 5: Reveal private key ────────────────────────────── */}
          {bioEnabled && (
            <>
              <div className="section-label" style={{ marginTop: 28 }}>
                Step 5 — reveal private key via biometric
              </div>
              <div className="card">
                <p style={{ margin: "0 0 12px", color: "var(--muted)", fontSize: 13 }}>
                  A separate one-time decrypt ceremony: <code>reveal({"{ biometricUnlock: reg }"})</code>{" "}
                  unwraps the stored blob to derive the one-time decryption key. Vault lock state does not
                  matter here. Auto-clears after 30 s.
                </p>

                {!solanaEntry ? (
                  <p className="hint">No embedded Solana wallet on this account.</p>
                ) : (
                  <>
                    <div className="wallet-row">
                      <div className="wallet-row-top">
                        <span className="badge badge-sol">SOL</span>
                        <span style={{ color: "var(--muted)", fontSize: 12 }}>{solanaEntry.role}</span>
                      </div>
                      <div className="key-line">
                        <span
                          style={{
                            fontFamily: "monospace",
                            fontSize: 12,
                            color: "var(--muted)",
                          }}
                        >
                          {solanaEntry.address.slice(0, 12)}…{solanaEntry.address.slice(-8)}
                        </span>
                      </div>

                      {plaintext && (
                        <div className="secret" style={{ marginTop: 8 }}>
                          <span style={{ color: "var(--yellow, #f0c060)", fontSize: 12 }}>
                            ⚠ Private key — never share this.
                          </span>
                          <code
                            style={{
                              display: "block",
                              marginTop: 4,
                              wordBreak: "break-all",
                              fontSize: 11,
                            }}
                          >
                            {plaintext}
                          </code>
                          <button className="mini-btn" style={{ marginTop: 6 }} onClick={clear}>
                            Clear now
                          </button>
                        </div>
                      )}
                    </div>

                    {!plaintext ? (
                      <button
                        className="btn btn-primary"
                        style={{ marginTop: 12 }}
                        onClick={revealWithBiometric}
                        disabled={revealLoading}
                      >
                        {revealLoading ? "Confirming…" : "Reveal with Face ID / Touch ID"}
                      </button>
                    ) : (
                      <div className="unlocked-tag" style={{ marginTop: 12 }}>
                        <ShieldIcon /> Key revealed — clears in 30 s
                      </div>
                    )}

                    {revealError && (
                      <div className="gate-error" style={{ marginTop: 8 }}>
                        {revealError.message}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </section>

        {/* ── Sidebar ──────────────────────────────────────────────────── */}
        <aside className="sidebar">
          {/* Session status */}
          <div className="card status">
            <div className="status-main">
              <span className={`dot ${vaultUnlocked ? "on" : "off"}`} />
              <div style={{ minWidth: 0 }}>
                <div className="status-title">
                  {!hasAccount ? "Not signed in" : auth.isLocked ? "Vault locked" : "Vault unlocked"}
                </div>
                <div className="status-sub" style={{ wordBreak: "break-all", fontSize: 11 }}>
                  {auth.publicKey
                    ? `${auth.publicKey.slice(0, 8)}…${auth.publicKey.slice(-6)}`
                    : "Sign in to start"}
                </div>
              </div>
            </div>
            {hasAccount && (
              <button
                className="btn-ghost"
                onClick={() => {
                  auth.logout();
                  setBioUnlockReg(null);
                  window.localStorage.removeItem(BIO_UNLOCK_KEY);
                  walletSigner.current = null;
                  setSigResult(null);
                  clear();
                }}
              >
                Sign out
              </button>
            )}
          </div>

          {/* Biometric state inspector */}
          {hasAccount && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="activity-head" style={{ marginBottom: 8 }}>
                <h3>Biometric state</h3>
              </div>
              <table
                style={{
                  width: "100%",
                  fontSize: 12,
                  borderCollapse: "collapse",
                }}
              >
                <tbody>
                  {(
                    [
                      ["available", String(bioUnlock.available)],
                      ["isEnabled", String(bioUnlock.isEnabled)],
                      ["reg saved", bioUnlockReg ? "yes" : "no"],
                      ["vault", auth.isLocked ? "locked" : "unlocked"],
                      ["solanaSigner", solanaSigner ? "live" : "null"],
                    ] as [string, string][]
                  ).map(([k, v]) => (
                    <tr key={k}>
                      <td
                        style={{
                          padding: "3px 0",
                          color: "var(--muted)",
                          paddingRight: 12,
                        }}
                      >
                        {k}
                      </td>
                      <td
                        style={{
                          padding: "3px 0",
                          fontFamily: "monospace",
                          color:
                            v === "true" || v === "live" || v === "unlocked" || v === "yes"
                              ? "var(--green, #4ade80)"
                              : v === "false" || v === "null" || v === "locked" || v === "no"
                                ? "var(--red)"
                                : "var(--fg)",
                        }}
                      >
                        {v}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Activity log */}
          <div className="card" style={{ marginTop: 12 }}>
            <div className="activity-head">
              <h3>Activity</h3>
              <span>live</span>
            </div>
            {log.length === 0 ? (
              <div className="log-empty">No events yet.</div>
            ) : (
              <pre className="log">
                {log.map((l, i) => (
                  <div key={i}>
                    <span className={l.ok ? "ok" : "err"}>{l.ok ? "✓" : "✕"}</span> {l.ts} {l.msg}
                  </div>
                ))}
              </pre>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

// ── Page root ────────────────────────────────────────────────────────────────

export default function BiometricPage() {
  // lockOnHide: false — crypto wallet signing opens a popup that backgrounds this
  // tab. With lockOnHide: true the vault expires before the signature returns.
  // Touch ID / Face ID sheets overlay the page without changing visibility.
  return (
    <AuthProvider apiBaseUrl="/api/auth" config={{ appId: APP_ID, autoLockMs: 60_000, lockOnHide: false }}>
      <BiometricPageInner />
    </AuthProvider>
  );
}
