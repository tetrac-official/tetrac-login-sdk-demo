"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { verifyMessage } from "viem";
import {
  useAuth,
  useUser,
  useWallets,
  useSolanaSigner,
  useEvmSigner,
  type WalletEntry,
  type ReauthCredentials,
} from "@tetrac/login-sdk/react";
import { ExportKeyPanel } from "@tetrac/login-sdk/ui";
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
import { APP_ID } from "../lib/appConfig";

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
  // SDK now owns the cached user record. The provider fetches /user-data
  // automatically on auth state change — no more local mirror.
  const { user, loading: userLoading } = useUser();
  const [email, setEmail] = useState("alice@example.com");
  const [passkey, setPasskey] = useState("correct horse battery staple");
  const [log, setLog] = useState<LogLine[]>([]);
  const [bioReg, setBioReg] = useState<PasskeyRegistration | null>(null);

  // Which method this session was authenticated with — read from the cached
  // user record so it survives a refetch and doesn't need a local mirror.
  const method: Method | null = (user?.authMethod as Method | undefined) ?? null;
  const walletSigner = useRef<Signer | null>(null); // persisted so reveal can re-sign

  // Reveal (re-auth) state — deliberately kept as the demo's educational
  // showcase: the SDK can't force re-auth, so the app does. The drop-in
  // <ExportKeyPanel> alternative is shown side-by-side under SignMessageCard.
  const [unlockedKey, setUnlockedKey] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [gatePasskey, setGatePasskey] = useState("");
  const [gateError, setGateError] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());

  // Whenever the active session changes (new login / logout), drop the
  // re-auth state so the next viewer has to unlock again.
  useEffect(() => {
    setUnlockedKey(null);
    setGateOpen(false);
    setGatePasskey("");
    setGateError(null);
    setShown(new Set());
  }, [user?.publicKey]);

  // SDK auto-lock (idle / tab hide) — re-lock the manual reveal ceremony in
  // lockstep so the WalletsPanel can't show stale plaintext past auto-lock.
  useEffect(() => {
    if (!auth.isLocked) return;
    setUnlockedKey(null);
    setGateOpen(false);
    setGatePasskey("");
    setGateError(null);
    setShown(new Set());
  }, [auth.isLocked]);

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

  // --- Method handlers ---
  // Auth actions just trigger the SDK — the provider's user-data fetch
  // populates `user` shortly after status flips to "authenticated".
  const emailRegister = async () => {
    await track("Email sign-up", () => auth.registerWithEmail({ email, passkey }));
  };
  const emailLogin = async () => {
    await track("Email sign-in", () => auth.loginWithEmail({ email, passkey }));
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
    await track("Crypto wallet", () => auth.connectWallet(signer));
  };

  const bioRegister = async () => {
    await track("Biometric setup", async () => {
      if (!(await isBiometricAvailable())) throw new Error("No Face ID / Touch ID on this device");
      const out = await auth.registerWithBiometric({ userName: "demo-user" });
      setBioReg(out.registration);
      return out;
    });
  };
  const bioLogin = async () => {
    if (!bioReg) return say(false, "Biometric sign-in — set up biometric first");
    await track("Biometric sign-in", () => auth.loginWithBiometric({ registration: bioReg }));
  };

  const onLogout = () => {
    auth.logout();
    walletSigner.current = null;
    // user clears automatically via useUser when status flips to unauthenticated;
    // reveal state clears via the effect on user?.publicKey above.
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
        key = deriveAppKeyFromPasskey(gatePasskey, user.email ?? "", user.pbkdf2Iterations);
      } else if (method === "wallet") {
        const signer = walletSigner.current;
        if (!signer) throw new Error("Wallet session lost — sign in again");
        // Re-sign the fixed message → same deterministic signature → same key.
        const sig = await signer.signMessage(new TextEncoder().encode(walletAppKeyMessage(APP_ID)));
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

  // `hasAccount` covers both "fully unlocked" and "locked" — panels must stay
  // mounted while the vault is locked so the user can re-authenticate. `authed`
  // is the strictly-unlocked variant used only for the status dot.
  const hasAccount = auth.hasAccount && user;
  const authed = auth.isAuthenticated && user;
  // Brief gap between login and the user-data fetch resolving.
  const loadingWallets = auth.hasAccount && !user && userLoading;

  return (
    <div className="layout">
      <section>
        {loadingWallets && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="log-empty">Loading your wallets…</div>
          </div>
        )}

        {hasAccount && (
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

        {hasAccount && (
          <SignMessageCard
            passkeyRegistration={bioReg}
            walletSignMessage={walletSigner.current?.signMessage}
          />
        )}

        {hasAccount && (
          <ExportKeyShowcase
            user={user!}
            passkeyRegistration={bioReg}
            walletSignMessage={walletSigner.current?.signMessage}
          />
        )}

        <div className="section-label">{hasAccount ? "Try another method" : "Choose your method"}</div>

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
              <div className="status-title">
                {hasAccount
                  ? auth.isLocked
                    ? "Vault locked — re-auth to sign"
                    : "You're signed in"
                  : "Not signed in yet"}
              </div>
              <div className="status-sub">
                {auth.publicKey ? shorten(auth.publicKey) : "Pick a method to get started"}
              </div>
            </div>
          </div>
          {hasAccount && (
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
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    if (!shown || !unlockedKey) {
      setSecret(null);
      return;
    }
    let cancelled = false;
    decryptWalletSecret(wallet, unlockedKey)
      .then((s) => {
        if (!cancelled) setSecret(s);
      })
      .catch(() => {
        if (!cancelled) setSecret("(failed to decrypt)");
      });
    return () => {
      cancelled = true;
    };
  }, [shown, unlockedKey, wallet]);

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const isSol = wallet.chain === "solana";

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
// Picks a wallet of the selected chain via useWallets() and signs through the
// SDK's ready-made high-level signers (useSolanaSigner / useEvmSigner). The
// envelope (decrypt → sign → drop) lives inside the SDK now — this component
// only assembles the message and verifies the signature locally.
//
// Lock model (PRD §4 Tier 1): signing is allowed within the unlocked window;
// after `autoLockMs` idle the vault locks and the signer hooks return null.
// When locked, we render an "Unlock to sign" ceremony that routes through
// auth.reauthenticate() to arm the SDK session — once unlocked, signing
// continues without a per-signature prompt (PRD §6.2 "unlocked-window model").
function SignMessageCard({
  passkeyRegistration,
  walletSignMessage,
}: {
  passkeyRegistration: PasskeyRegistration | null;
  walletSignMessage?: (m: Uint8Array) => Promise<Uint8Array>;
}) {
  const wallets = useWallets();
  const { user } = useUser();
  const auth = useAuth();
  // The account's auth method picks which re-auth ceremony to render.
  const method = (user?.authMethod as Method | undefined) ?? null;

  const [chain, setChain] = useState<SignChain>("solana");
  const [message, setMessage] = useState("Hello from next-ttc-login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ publicKey: string; signature: string; valid: boolean } | null>(null);

  // Unlock-to-sign ceremony state (only relevant while the vault is locked).
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlockGateOpen, setUnlockGateOpen] = useState(false);
  const [unlockPasskey, setUnlockPasskey] = useState("");

  // Prefer the agent ("signing") wallet so the demo doesn't sign with the funds wallet by default.
  const wallet = useMemo<WalletEntry | null>(
    () =>
      wallets.find((w: WalletEntry) => w.chain === chain && w.role === "signing") ??
      wallets.find((w: WalletEntry) => w.chain === chain) ??
      null,
    [wallets, chain],
  );

  // Hooks must be called unconditionally; gate the wallet arg by chain so each
  // signer only receives the matching wallet type (the SDK throws otherwise).
  const solWallet = wallet?.chain === "solana" ? wallet.encrypted : null;
  const evmWallet = wallet?.chain === "evm" ? wallet.encrypted : null;
  const solSigner = useSolanaSigner(solWallet);
  const evmSigner = useEvmSigner(evmWallet);

  // Clear stale signature when the user flips chains or edits the message.
  useEffect(() => setResult(null), [chain, message]);
  // Drop any stale unlock UI as soon as the vault is armed again.
  useEffect(() => {
    if (auth.isLocked) return;
    setUnlockError(null);
    setUnlockGateOpen(false);
    setUnlockPasskey("");
  }, [auth.isLocked]);

  async function sign() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const msgBytes = new TextEncoder().encode(message);

      if (wallet.chain === "solana") {
        if (!solSigner) throw new Error("Solana signer unavailable (session locked?)");
        const sig = await solSigner.signMessage(msgBytes);
        const valid = nacl.sign.detached.verify(msgBytes, sig, new PublicKey(wallet.address).toBytes());
        setResult({ publicKey: wallet.address, signature: toBase64(sig), valid });
      } else {
        if (!evmSigner) throw new Error("EVM signer unavailable (session locked?)");
        const signature = await evmSigner.signMessage({ message });
        const valid = await verifyMessage({ address: evmSigner.address, message, signature });
        setResult({ publicKey: wallet.address, signature, valid });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Run the active method's re-auth ceremony and arm the SDK session. After
  // this resolves, the signer hooks observe the unlocked vault and sign()
  // proceeds normally.
  async function doUnlock(creds: ReauthCredentials) {
    setUnlockBusy(true);
    setUnlockError(null);
    try {
      await auth.reauthenticate(creds);
      setUnlockGateOpen(false);
      setUnlockPasskey("");
    } catch (e) {
      const msg = (e as Error).message || "Could not unlock.";
      setUnlockError(method === "email" ? "Wrong passkey — try again." : msg);
    } finally {
      setUnlockBusy(false);
    }
  }

  async function unlockEmail() {
    if (!unlockPasskey) {
      setUnlockGateOpen(true);
      return;
    }
    await doUnlock({ passkey: unlockPasskey });
  }
  async function unlockWallet() {
    if (!walletSignMessage) {
      setUnlockError("Wallet session lost — sign in again.");
      return;
    }
    await doUnlock({ signMessage: walletSignMessage });
  }
  async function unlockBiometric() {
    if (!passkeyRegistration) {
      setUnlockError("No passkey on file.");
      return;
    }
    await doUnlock({ registration: passkeyRegistration });
  }

  const noWallet = wallets.length > 0 && !wallet;
  const locked = auth.isLocked;

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
          Signing as <code title={wallet.address}>{shorten(wallet.address)}</code>{" "}
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

      {locked ? (
        method === "email" && unlockGateOpen ? (
          // Email path: collect the passkey inline before arming the session.
          <div className="gate">
            <div className="gate-title">Enter your passkey to unlock signing</div>
            <input
              className="input"
              type="password"
              placeholder="enter your passkey"
              value={unlockPasskey}
              onChange={(e) => setUnlockPasskey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && unlockEmail()}
              autoFocus
            />
            {unlockError && <div className="gate-error">{unlockError}</div>}
            <div className="gate-row">
              <button
                className="btn btn-primary"
                onClick={unlockEmail}
                disabled={unlockBusy || !unlockPasskey}
              >
                {unlockBusy ? "Unlocking…" : "Unlock to sign"}
              </button>
              <button
                className="btn btn-outline"
                onClick={() => {
                  setUnlockGateOpen(false);
                  setUnlockPasskey("");
                  setUnlockError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          // Lock banner with a per-method CTA. Wallet → re-sign the fixed
          // app-key message; biometric → fresh Face ID / Touch ID prompt.
          <>
            <div className="lock-banner">
              <span className="lock-text">
                <ShieldIcon /> Vault is locked. Re-authenticate to sign.
              </span>
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (method === "email") unlockEmail();
                  else if (method === "wallet") unlockWallet();
                  else unlockBiometric();
                }}
                disabled={unlockBusy}
              >
                {unlockBusy
                  ? "Unlocking…"
                  : method === "email"
                    ? "Unlock to sign"
                    : method === "wallet"
                      ? "Sign to unlock"
                      : "Unlock with Face ID / Touch ID"}
              </button>
            </div>
            {unlockError && (
              <div className="gate-error" style={{ marginTop: 8 }}>
                {unlockError}
              </div>
            )}
          </>
        )
      ) : (
        <button className="btn btn-primary" onClick={sign} disabled={!wallet || !message.trim() || busy}>
          {busy ? "Signing…" : "Sign message"}
        </button>
      )}

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

// --- Export Key showcase ---
// The drop-in <ExportKeyPanel>. It runs a fresh re-auth ceremony for every
// reveal (passkey / Face ID / wallet signature) and derives a one-time key — it
// never reads the session key, so it honors "Re-auth to reveal" just like the
// manual ceremony above.
function ExportKeyShowcase({
  user,
  passkeyRegistration,
  walletSignMessage,
}: {
  user: UserData;
  passkeyRegistration: PasskeyRegistration | null;
  walletSignMessage?: (m: Uint8Array) => Promise<Uint8Array>;
}) {
  // Default to the Solana funds wallet — that's the user's primary identity.
  const wallet = useMemo<EncryptedWallet | null>(
    () => user.wallets.find((w) => w.chain === "solana" && w.role === "funds") ?? user.wallets[0] ?? null,
    [user.wallets],
  );

  if (!wallet) return null;

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="panel-head">
        <h2>Or: drop-in &lt;ExportKeyPanel /&gt;</h2>
        <p>
          Same secret, less code. The SDK&apos;s optional UI ships a panel with auto-clear, clipboard wipe,
          and a React-Native-WebView <code>postMessage</code> contract — and it re-authenticates on every
          reveal, so the key never appears without a fresh ceremony.
        </p>
      </div>
      <ExportKeyPanel
        wallet={wallet}
        autoClearMs={45_000}
        clipboardClearMs={20_000}
        title={null}
        passkeyRegistration={passkeyRegistration}
        walletSignMessage={walletSignMessage}
        description={`Reveals the ${wallet.chain.toUpperCase()} ${wallet.role} key after re-auth. Auto-clears after 45 s; clipboard wipes after 20 s.`}
        appearance={{ accent: "#3a479e", radius: 10 }}
        styles={{
          root: { color: "var(--fg)", maxWidth: "100%" },
          description: { color: "var(--muted)" },
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
          secretBlock: {
            background: "var(--elevated)",
            border: "1px solid var(--border)",
            color: "var(--fg)",
          },
          error: { color: "var(--red)" },
        }}
      />
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
