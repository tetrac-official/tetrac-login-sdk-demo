"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useAuth } from "@tetrac/login-sdk/react";
import {
  deriveAppKeyFromPasskey,
  deriveAppKeyFromSignature,
  walletAppKeyMessage,
  type UserData,
  type EncryptedWallet,
} from "@tetrac/login-sdk/core";
import {
  isBiometricAvailable,
  decryptWalletSecret,
  derivePasskeySecret,
  type PasskeyRegistration,
} from "@tetrac/login-sdk/client";
import { MailIcon, WalletIcon, FingerprintIcon, ShieldIcon } from "./icons";

type SignChain = "solana" | "evm";

type Method = "email" | "wallet" | "biometric";
type LogLine = { ok: boolean; msg: string; time: string };
type Signer = { publicKey: string; signMessage: (m: Uint8Array) => Promise<Uint8Array> };

// Injected Solana wallet (Phantom and most others expose window.solana / window.phantom.solana).
function getInjectedSolana(): {
  connect: () => Promise<unknown>;
  publicKey?: { toString(): string };
  signMessage: (m: Uint8Array, display?: string) => Promise<{ signature: Uint8Array } | Uint8Array>;
} | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { solana?: any; phantom?: { solana?: any } };
  return w.phantom?.solana ?? w.solana ?? null;
}

export function DemoShell() {
  const auth = useAuth();
  const [email, setEmail] = useState("alice@example.com");
  const [passkey, setPasskey] = useState("correct horse battery staple");
  const [log, setLog] = useState<LogLine[]>([]);
  const [bioReg, setBioReg] = useState<PasskeyRegistration | null>(null);

  // Post-login state
  const [user, setUser] = useState<UserData | null>(null);
  const [method, setMethod] = useState<Method | null>(null);
  const walletSigner = useRef<Signer | null>(null); // persisted so reveal can re-sign

  // Reveal (re-auth) state
  const [unlockedKey, setUnlockedKey] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [gatePasskey, setGatePasskey] = useState("");
  const [gateError, setGateError] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());

  const say = (ok: boolean, msg: string) =>
    setLog((l) => [{ ok, msg, time: new Date().toLocaleTimeString() }, ...l]);

  // Run an SDK action, log the outcome, return result (or null on error).
  async function track<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const r = await fn();
      say(true, `${label} — ${summarize(r)}`);
      return r;
    } catch (e) {
      say(false, `${label} — ${(e as Error).message}`);
      return null;
    }
  }

  function onAuthed(u: UserData, m: Method) {
    // Normalize: older/edge records may lack the wallets array.
    setUser({ ...u, wallets: Array.isArray(u.wallets) ? u.wallets : [] });
    setMethod(m);
    // New session → relock private keys until the user re-authenticates.
    setUnlockedKey(null);
    setGateOpen(false);
    setGateError(null);
    setShown(new Set());
  }

  // --- Method handlers ---
  const emailRegister = async () => {
    const r = await track("Email sign-up", () => auth.registerWithEmail({ email, passkey }));
    if (r) onAuthed(r.user, "email");
  };
  const emailLogin = async () => {
    const r = await track("Email sign-in", () => auth.loginWithEmail({ email, passkey }));
    if (r) onAuthed(r.user, "email");
  };

  const walletConnect = async () => {
    let signer: Signer;
    const provider = getInjectedSolana();
    if (provider) {
      // Real wallet (Phantom etc.): connect, then sign — this triggers the popups.
      try {
        await provider.connect();
      } catch {
        return say(false, "Crypto wallet — connection rejected");
      }
      const publicKey = provider.publicKey?.toString();
      if (!publicKey) return say(false, "Crypto wallet — no public key from wallet");
      signer = {
        publicKey,
        signMessage: async (m) => {
          const res = await provider.signMessage(m, "utf8");
          return "signature" in (res as object)
            ? (res as { signature: Uint8Array }).signature
            : (res as Uint8Array);
        },
      };
      say(true, `Wallet detected — ${shorten(publicKey)}`);
    } else {
      // No wallet installed: simulate one so the demo still works end-to-end.
      const kp = Keypair.generate();
      signer = {
        publicKey: kp.publicKey.toBase58(),
        signMessage: async (m) => nacl.sign.detached(m, kp.secretKey),
      };
      say(true, "No wallet installed — using a simulated key");
    }
    walletSigner.current = signer; // kept so reveal can re-sign the fixed message
    const r = await track("Crypto wallet", () => auth.connectWallet(signer));
    if (r) onAuthed(r.user, "wallet");
  };

  const bioRegister = async () => {
    const r = await track("Biometric setup", async () => {
      if (!(await isBiometricAvailable())) throw new Error("No Face ID / Touch ID on this device");
      const out = await auth.registerWithBiometric({ userName: "demo-user" });
      setBioReg(out.registration);
      return out;
    });
    if (r) onAuthed(r.result.user, "biometric");
  };
  const bioLogin = async () => {
    if (!bioReg) return say(false, "Biometric sign-in — set up biometric first");
    const r = await track("Biometric sign-in", () => auth.loginWithBiometric({ registration: bioReg }));
    if (r) onAuthed(r.user, "biometric");
  };

  const onLogout = () => {
    auth.logout();
    setUser(null);
    setMethod(null);
    setUnlockedKey(null);
    setGateOpen(false);
    setShown(new Set());
  };

  // --- Re-auth to unlock private keys ---
  // Re-derives the app key from the chosen method and proves it by decrypting a
  // wallet. The key is never read from the session — the user must authenticate again.
  async function unlock() {
    if (!user) return;
    setGateError(null);
    try {
      let key: string;
      if (method === "email") {
        key = deriveAppKeyFromPasskey(gatePasskey, user.email ?? "");
      } else if (method === "wallet") {
        const signer = walletSigner.current;
        if (!signer) throw new Error("Wallet session lost — sign in again");
        // Re-sign the fixed message → same deterministic signature → same key.
        const sig = await signer.signMessage(new TextEncoder().encode(walletAppKeyMessage()));
        key = deriveAppKeyFromSignature(toHex(sig));
      } else {
        if (!bioReg) throw new Error("No passkey on file");
        key = await derivePasskeySecret(bioReg);
      }
      // Validate: a wrong key throws on decrypt.
      if (user.wallets[0]) decryptWalletSecret(user.wallets[0], key);
      setUnlockedKey(key);
      setGateOpen(false);
      setGatePasskey("");
      say(true, "Private keys unlocked");
    } catch (e) {
      const msg = reauthErr(method, e as Error);
      setGateError(msg);
      // wallet/biometric have no inline gate, so surface the failure in the log too.
      if (method !== "email") say(false, `Unlock — ${msg}`);
    }
  }

  function toggleShow(pk: string) {
    setShown((s) => {
      const next = new Set(s);
      next.has(pk) ? next.delete(pk) : next.add(pk);
      return next;
    });
  }

  const authed = auth.isAuthenticated && user;

  return (
    <div className="layout">
      <section>
        {authed && (
          <WalletsPanel
            user={user!}
            method={method!}
            unlockedKey={unlockedKey}
            gateOpen={gateOpen}
            gateError={gateError}
            gatePasskey={gatePasskey}
            shown={shown}
            onOpenGate={() => setGateOpen(true)}
            onCloseGate={() => setGateOpen(false)}
            onGatePasskey={setGatePasskey}
            onUnlock={unlock}
            onToggleShow={toggleShow}
          />
        )}

        {authed && <SignMessageCard wallets={user!.wallets ?? []} appKey={unlockedKey} />}

        <div className="section-label">{authed ? "Try another method" : "Choose your method"}</div>

        <div className="methods">
          <Method
            icon={<MailIcon />}
            title="Email & passkey"
            desc="The simple way in. Sign in with your email and a passkey — your wallets are set up for you automatically."
          >
            <div className="field-row">
              <input
                className="input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <input
                className="input"
                type="password"
                placeholder="passkey"
                value={passkey}
                onChange={(e) => setPasskey(e.target.value)}
              />
            </div>
            <button className="btn btn-primary" onClick={emailRegister}>
              Create account
            </button>
            <button className="link" onClick={emailLogin}>
              Already have an account? Sign in
            </button>
          </Method>

          <Method
            icon={<WalletIcon />}
            title="Crypto wallet"
            desc="Got a Solana wallet? Sign a quick message to prove it's yours. No passwords, nothing to remember."
          >
            <button className="btn btn-primary" onClick={walletConnect}>
              Continue with wallet
            </button>
            <p className="hint">
              Uses your installed Solana wallet (Phantom). No wallet? We&apos;ll simulate one.
            </p>
          </Method>

          <Method
            icon={<FingerprintIcon />}
            title="Face ID / Touch ID"
            desc="Your face or fingerprint is the key. Fast, private, and nothing to type."
          >
            <div className="btn-row">
              <button className="btn btn-primary" onClick={bioRegister}>
                Set up biometric
              </button>
              <button className="btn btn-outline" onClick={bioLogin}>
                Sign in with biometric
              </button>
            </div>
            <p className="hint">Needs a device with Face ID or Touch ID.</p>
          </Method>
        </div>
      </section>

      <aside className="sidebar">
        <div className="card status">
          <div className="status-main">
            <span className={`dot ${authed ? "on" : "off"}`} />
            <div style={{ minWidth: 0 }}>
              <div className="status-title">{authed ? "You're signed in" : "Not signed in yet"}</div>
              <div className="status-sub">
                {auth.publicKey ? shorten(auth.publicKey) : "Pick a method to get started"}
              </div>
            </div>
          </div>
          {authed && (
            <button className="btn-ghost" onClick={onLogout}>
              Sign out
            </button>
          )}
        </div>

        <div className="card">
          <div className="activity-head">
            <h3>Activity</h3>
            <span>live from the SDK</span>
          </div>
          {log.length === 0 ? (
            <div className="log-empty">Try a method — you'll see what happens here.</div>
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
    </div>
  );
}

// --- Wallets panel ---
function WalletsPanel(props: {
  user: UserData;
  method: Method;
  unlockedKey: string | null;
  gateOpen: boolean;
  gateError: string | null;
  gatePasskey: string;
  shown: Set<string>;
  onOpenGate: () => void;
  onCloseGate: () => void;
  onGatePasskey: (v: string) => void;
  onUnlock: () => void;
  onToggleShow: (pk: string) => void;
}) {
  const { user, method, unlockedKey } = props;
  const wallets = user.wallets ?? []; // never trust the field to be present
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <h2>Your wallets</h2>
        <p>
          Generated &amp; encrypted on your device — {wallets.length} key{wallets.length === 1 ? "" : "s"}{" "}
          across Solana &amp; EVM.
        </p>
      </div>

      {wallets.length === 0 ? (
        <div className="log-empty">No generated wallets on this account.</div>
      ) : (
        <div className="wallet-list">
          {wallets.map((w) => (
            <WalletRow
              key={`${w.chain}:${w.role}`}
              wallet={w}
              unlockedKey={unlockedKey}
              shown={props.shown.has(w.publicKey)}
              onToggleShow={() => props.onToggleShow(w.publicKey)}
            />
          ))}
        </div>
      )}

      {wallets.length > 0 &&
        (!unlockedKey ? (
          props.gateOpen ? (
            <div className="gate">
              <div className="gate-title">{gatePrompt(method)}</div>
              {method === "email" && (
                <input
                  className="input"
                  type="password"
                  placeholder="enter your passkey"
                  value={props.gatePasskey}
                  onChange={(e) => props.onGatePasskey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && props.onUnlock()}
                  autoFocus
                />
              )}
              {props.gateError && <div className="gate-error">{props.gateError}</div>}
              <div className="gate-row">
                <button className="btn btn-primary" onClick={props.onUnlock}>
                  {gateAction(method)}
                </button>
                <button className="btn btn-outline" onClick={props.onCloseGate}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="lock-banner">
              <span className="lock-text">
                <ShieldIcon /> Private keys are locked. Re-authenticate to reveal them.
              </span>
              {/* Email collects a passkey first; wallet/biometric prompt directly. */}
              <button
                className="btn btn-primary"
                onClick={() => (method === "email" ? props.onOpenGate() : props.onUnlock())}
              >
                {gateAction(method)}
              </button>
            </div>
          )
        ) : (
          <div className="unlocked-tag">
            <ShieldIcon /> Unlocked — tap “Show” on any wallet to reveal its private key.
          </div>
        ))}
    </div>
  );
}

function WalletRow(props: {
  wallet: EncryptedWallet;
  unlockedKey: string | null;
  shown: boolean;
  onToggleShow: () => void;
}) {
  const { wallet, unlockedKey, shown } = props;
  const [copied, setCopied] = useState(false);

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const isSol = wallet.chain === "solana";
  let secret: string | null = null;
  if (shown && unlockedKey) {
    try {
      secret = decryptWalletSecret(wallet, unlockedKey);
    } catch {
      secret = "(failed to decrypt)";
    }
  }

  return (
    <div className="wallet-row">
      <div className="wallet-row-top">
        <span className={`badge ${isSol ? "badge-sol" : "badge-evm"}`}>{isSol ? "SOL" : "EVM"}</span>
        <span className="role">
          {titleCase(wallet.role)} <small>{wallet.role === "signing" ? "· agent" : "· holds assets"}</small>
        </span>
      </div>

      <div className="key-line">
        <span className="key" title={wallet.publicKey}>
          {wallet.publicKey}
        </span>
        <button className="mini-btn" onClick={() => copy(wallet.publicKey)}>
          {copied ? "Copied" : "Copy"}
        </button>
        {unlockedKey && (
          <button className="mini-btn danger" onClick={props.onToggleShow}>
            {shown ? "Hide" : "Show"}
          </button>
        )}
      </div>

      {shown && secret && (
        <div className="secret">
          <span className="warn">⚠ Private key — never share this.</span>
          <code>{secret}</code>
        </div>
      )}
    </div>
  );
}

// --- Sign Message card ---
// Picks a wallet of the selected chain, decrypts its secret with the unlocked
// appKey, signs the user-supplied message, and verifies the signature locally.
// Solana uses tweetnacl; EVM uses viem. Both round-trips are fully offline — no RPC.
function SignMessageCard(props: { wallets: EncryptedWallet[]; appKey: string | null }) {
  const { wallets, appKey } = props;
  const [chain, setChain] = useState<SignChain>("solana");
  const [message, setMessage] = useState("Hello from next-ttc-login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ publicKey: string; signature: string; valid: boolean } | null>(null);

  // Prefer the agent ("signing") wallet so the demo doesn't sign with the funds wallet by default.
  const wallet = useMemo(
    () =>
      wallets.find((w) => w.chain === chain && w.role === "signing") ??
      wallets.find((w) => w.chain === chain) ??
      null,
    [wallets, chain],
  );

  // Clear stale signature when the user flips chains or edits the message.
  useEffect(() => setResult(null), [chain, message]);

  async function sign() {
    if (!appKey || !wallet) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Decrypt the secret only for the duration of this handler — no long-lived plaintext key.
      const secret = decryptWalletSecret(wallet, appKey);
      const msgBytes = new TextEncoder().encode(message);

      if (wallet.chain === "solana") {
        const secretBytes = hexToBytes(secret); // 64-byte Solana secret key
        const kp = Keypair.fromSecretKey(secretBytes);
        const sig = nacl.sign.detached(msgBytes, secretBytes);
        const valid = nacl.sign.detached.verify(msgBytes, sig, kp.publicKey.toBytes());
        setResult({ publicKey: wallet.publicKey, signature: toBase64(sig), valid });
      } else {
        const account = privateKeyToAccount(secret as `0x${string}`);
        const signature = await account.signMessage({ message });
        const valid = await verifyMessage({ address: account.address, message, signature });
        setResult({ publicKey: wallet.publicKey, signature, valid });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const noWallet = wallets.length > 0 && !wallet;

  return (
    <div className="card sign-card">
      <div className="panel-head">
        <h2>Sign a message</h2>
        <p>Prove you control this wallet — fully offline, no RPC, no broadcast.</p>
      </div>

      {/* Chain toggle — pill-style two-button segmented control. */}
      <div className="chain-toggle">
        <button
          className={`toggle-btn ${chain === "solana" ? "active" : ""}`}
          onClick={() => setChain("solana")}
          type="button"
        >
          <span className="badge badge-sol">SOL</span> Solana
        </button>
        <button
          className={`toggle-btn ${chain === "evm" ? "active" : ""}`}
          onClick={() => setChain("evm")}
          type="button"
        >
          <span className="badge badge-evm">EVM</span> EVM
        </button>
      </div>

      {wallet && (
        <div className="signing-as">
          Signing as <code title={wallet.publicKey}>{shorten(wallet.publicKey)}</code>{" "}
          <small>· {titleCase(wallet.role)} wallet</small>
        </div>
      )}
      {noWallet && (
        <div className="signing-as" style={{ color: "var(--red)" }}>
          No {chain === "solana" ? "Solana" : "EVM"} wallet on this account.
        </div>
      )}

      <textarea
        className="input textarea"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Type a message to sign…"
        rows={3}
      />

      <button
        className="btn btn-primary"
        onClick={sign}
        disabled={!appKey || !wallet || !message.trim() || busy}
      >
        {busy ? "Signing…" : !appKey ? "Unlock above to sign" : "Sign message"}
      </button>

      {error && (
        <div className="gate-error" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      {result && (
        <div className="sig-result">
          <div className={`sig-status ${result.valid ? "ok" : "err"}`}>
            {result.valid ? "✓ Signature verified locally" : "✕ Verification failed"}
          </div>
          <div className="sig-meta">
            From: <code title={result.publicKey}>{shorten(result.publicKey)}</code>
          </div>
          <code className="sig-bytes">{result.signature}</code>
        </div>
      )}
    </div>
  );
}

// --- Small components & helpers ---
function Method({
  icon,
  title,
  desc,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card method">
      <div className="method-head">
        <div className="icon-chip">{icon}</div>
        <div>
          <p className="method-title">{title}</p>
          <p className="method-desc">{desc}</p>
        </div>
      </div>
      <div className="method-body">{children}</div>
    </div>
  );
}

function gatePrompt(m: Method): string {
  if (m === "email") return "Enter your passkey to decrypt your keys";
  if (m === "wallet") return "Sign a message with your wallet to decrypt your keys";
  return "Confirm with Face ID / Touch ID to decrypt your keys";
}
function gateAction(m: Method): string {
  if (m === "email") return "Unlock with passkey";
  if (m === "wallet") return "Sign to unlock";
  return "Unlock with biometrics";
}
function reauthErr(m: Method | null, e: Error): string {
  if (m === "email") return "Wrong passkey — try again.";
  return e.message || "Could not unlock.";
}
function shorten(key: string): string {
  return key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key;
}
function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function summarize(r: unknown): string {
  if (r && typeof r === "object") {
    if ("publicKey" in r) return `signed in as ${shorten((r as { publicKey: string }).publicKey)}`;
    if ("result" in r)
      return `signed in as ${shorten((r as { result: { publicKey: string } }).result.publicKey)}`;
  }
  return "done";
}
