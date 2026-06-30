"use client";

// Ledger hardware-wallet login — exercises @tetrac/login-sdk/ledger (0.4.1+).
//
// What this page proves end-to-end:
//   1. Native USB/HID connect + address derivation (no Phantom, no extension).
//   2. LOGIN with a Ledger: connectWallet() prompts the device twice (ownership
//      + app-key), both as Solana OFF-CHAIN message signatures. The server now
//      verifies that envelope, so the old "401 / signature didn't match" is gone.
//   3. The encrypted embedded wallet DECRYPTS: its key is derived from the
//      Ledger's deterministic off-chain signature, so the bundle generated at
//      sign-up unlocks on the same device — the "encrypted blob failed" is gone.
//
// Requirements: Chrome or Edge over HTTPS (or localhost), with the Solana app
// open and unlocked on the device.
import { useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { AuthProvider, useAuth, useUser, useSolanaSigner } from "@tetrac/login-sdk/react";
import { useSolanaLedger, offchainMessageCandidates } from "@tetrac/login-sdk/ledger";
import type { EncryptedWallet } from "@tetrac/login-sdk/core";
import { APP_ID } from "../lib/appConfig";

type LogLine = { ok: boolean; msg: string; time: string };

function shorten(key: string): string {
  return key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key;
}
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function LedgerInner() {
  const ledger = useSolanaLedger();
  const auth = useAuth();
  const { user } = useUser();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [deviceSig, setDeviceSig] = useState<{ valid: boolean; signature: string } | null>(null);
  const [embeddedSig, setEmbeddedSig] = useState<{ valid: boolean; signature: string } | null>(null);

  const say = (ok: boolean, msg: string) =>
    setLog((l) => [{ ok, msg, time: new Date().toLocaleTimeString() }, ...l]);

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

  const selected = useMemo(
    () => ledger.addresses.find((a) => a.path === selectedPath) ?? null,
    [ledger.addresses, selectedPath],
  );

  // The embedded agent wallet generated at sign-up (encrypted under the key the
  // Ledger signature derives). A ready signer over it proves the blob decrypts.
  const embeddedWallet = useMemo<EncryptedWallet | null>(
    () => user?.wallets.find((w) => w.chain === "solana" && w.role === "signing") ?? user?.wallets[0] ?? null,
    [user],
  );
  const embeddedSigner = useSolanaSigner(embeddedWallet);

  // --- Device actions ---
  const connect = () =>
    run("Connect", "connect", async () => {
      await ledger.connect();
      if (ledger.isConnected || true) say(true, "Transport open — checking Solana app…");
    });

  const derive = () =>
    run("Derive addresses", "derive", async () => {
      await ledger.deriveAddresses(5);
      say(true, "Derived 5 addresses on m/44'/501'/i'/0'");
    });

  const confirmOnDevice = (path: string) =>
    run("Confirm on device", "confirm", async () => {
      const addr = await ledger.confirmAddress(path);
      say(true, `Device confirmed ${shorten(addr)}`);
    });

  // --- The login fix (Problem 1) ---
  const signIn = () =>
    run("Ledger sign-in", "signin", async () => {
      if (!selected) throw new Error("Select a derived address first");
      // One signer bound to the selected path/address. connectWallet calls its
      // signMessage twice (ownership + app-key) — approve both on the device.
      // hardwareWallet: true → the app-key message is newline-free so the Ledger
      // can clear-sign it (a newline triggers 0x6a82 / blind-signing on the device).
      const signer = ledger.getSolanaSigner({ path: selected.path, address: selected.address });
      await auth.connectWallet({
        publicKey: selected.address,
        signMessage: signer.signMessage,
        hardwareWallet: true,
      });
      say(true, `Signed in as ${shorten(selected.address)} (off-chain signature accepted)`);
    });

  // --- Hardware off-chain signature demo ---
  const signWithDevice = () =>
    run("Device signMessage", "devsign", async () => {
      if (!selected) throw new Error("Select a derived address first");
      const signer = ledger.getSolanaSigner({ path: selected.path, address: selected.address });
      const msg = new TextEncoder().encode(`Hello from Ledger @ ${new Date().toISOString()}`);
      const sig = await signer.signMessage(msg);
      // The device signs whichever off-chain envelope its firmware accepts
      // (legacy or v0) — verify against any known candidate.
      const pk = new PublicKey(selected.address).toBytes();
      const valid = offchainMessageCandidates(msg, pk).some((env) => nacl.sign.detached.verify(env, sig, pk));
      setDeviceSig({ valid, signature: toBase64(sig) });
      say(valid, `Device off-chain signature ${valid ? "verified" : "FAILED"}`);
    });

  // --- The blob fix (Problem 2) ---
  const signWithEmbedded = () =>
    run("Embedded signMessage", "embsign", async () => {
      if (!embeddedSigner || !embeddedWallet) throw new Error("Embedded signer unavailable (locked?)");
      const msg = new TextEncoder().encode("Signed by the embedded agent wallet");
      const sig = await embeddedSigner.signMessage(msg);
      const valid = nacl.sign.detached.verify(msg, sig, new PublicKey(embeddedWallet.publicKey).toBytes());
      setEmbeddedSig({ valid, signature: toBase64(sig) });
      say(valid, `Embedded wallet decrypted & signed ${valid ? "✓" : "FAILED"}`);
    });

  const disconnect = () =>
    run("Disconnect", "disconnect", async () => {
      await ledger.disconnect();
      setSelectedPath(null);
      setDeviceSig(null);
      say(true, "Disconnected");
    });

  const authed = auth.isAuthenticated && !!user;

  return (
    <main className="page">
      <header className="hero">
        <span className="eyebrow">@tetrac/login-sdk/ledger</span>
        <h1>
          Sign in with <span className="grad">Ledger</span>
        </h1>
        <p>
          Native WebUSB/WebHID — no browser extension. Connect the device, derive an address, and log in. The
          server verifies the Solana <strong>off-chain message</strong> signature, and the embedded wallet
          generated at sign-up decrypts from the same hardware key.
        </p>
        <div className="trust">
          <Link href="/" className="link">
            ← Back to demo
          </Link>
        </div>
      </header>

      <div
        className="card"
        style={{ padding: 14, marginTop: 18, borderColor: "var(--border)", color: "var(--muted)" }}
      >
        ⚠ Requires <strong>Chrome or Edge</strong> over HTTPS (or localhost), with the{" "}
        <strong>Solana app open and unlocked</strong> on your Ledger.
      </div>

      <section className="layout" style={{ marginTop: 18 }}>
        <div>
          {/* Step 1 — Device */}
          <div className="card" style={{ padding: 20 }}>
            <div className="panel-head">
              <h2>1 · Device</h2>
              <p>
                Status: <code>{ledger.deviceStatus}</code>
              </p>
            </div>
            {ledger.error && (
              <div className="gate-error" style={{ marginBottom: 10 }}>
                {ledger.error}
              </div>
            )}

            <div className="btn-row" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {!ledger.isConnected ? (
                <button className="btn btn-primary" onClick={connect} disabled={busy === "connect"}>
                  {ledger.isConnecting || busy === "connect" ? "Connecting…" : "Connect Ledger"}
                </button>
              ) : (
                <>
                  <button className="btn btn-primary" onClick={derive} disabled={busy === "derive"}>
                    {ledger.isDerivingAddresses || busy === "derive" ? "Deriving…" : "Derive addresses"}
                  </button>
                  <button className="btn btn-outline" onClick={disconnect} disabled={busy === "disconnect"}>
                    Disconnect
                  </button>
                </>
              )}
            </div>

            {ledger.addresses.length > 0 && (
              <div className="wallet-list" style={{ marginTop: 14 }}>
                {ledger.addresses.map((a) => (
                  <label
                    key={a.path}
                    className="wallet-row"
                    style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
                  >
                    <input
                      type="radio"
                      name="ledger-addr"
                      checked={selectedPath === a.path}
                      onChange={() => setSelectedPath(a.path)}
                    />
                    <span className="badge badge-sol">#{a.index}</span>
                    <code className="key" title={a.address} style={{ flex: 1 }}>
                      {shorten(a.address)}
                    </code>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={(e) => {
                        e.preventDefault();
                        confirmOnDevice(a.path);
                      }}
                      disabled={busy === "confirm"}
                    >
                      Confirm on device
                    </button>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Step 2 — Sign in (Problem 1) */}
          <div className="card" style={{ padding: 20, marginTop: 16 }}>
            <div className="panel-head">
              <h2>2 · Sign in</h2>
              <p>The login + app-key signatures are off-chain envelopes — the server now accepts both.</p>
            </div>
            {selected ? (
              <div className="signing-as" style={{ marginBottom: 10 }}>
                Using <code title={selected.address}>{shorten(selected.address)}</code>{" "}
                <small>· {selected.path}</small>
              </div>
            ) : (
              <div className="signing-as" style={{ color: "var(--muted)", marginBottom: 10 }}>
                Select a derived address above.
              </div>
            )}
            {!authed ? (
              <button className="btn btn-primary" onClick={signIn} disabled={!selected || busy === "signin"}>
                {busy === "signin" ? "Approve 2 prompts on device…" : "Sign in with Ledger"}
              </button>
            ) : (
              <div className="unlocked-tag">✓ Signed in — server accepted the off-chain signature.</div>
            )}

            {selected && (
              <div style={{ marginTop: 12 }}>
                <button className="btn btn-outline" onClick={signWithDevice} disabled={busy === "devsign"}>
                  {busy === "devsign" ? "Confirm on device…" : "Test: sign a message on the device"}
                </button>
                {deviceSig && (
                  <div className="sig-result" style={{ marginTop: 10 }}>
                    <div className={`sig-status ${deviceSig.valid ? "ok" : "err"}`}>
                      {deviceSig.valid ? "✓ Off-chain signature verified" : "✕ Verification failed"}
                    </div>
                    <code className="sig-bytes">{deviceSig.signature}</code>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Step 3 — Embedded blob (Problem 2) */}
          {authed && (
            <div className="card" style={{ padding: 20, marginTop: 16 }}>
              <div className="panel-head">
                <h2>3 · Embedded wallet decrypts</h2>
                <p>
                  Generated at sign-up and encrypted under a key derived from your Ledger&apos;s signature.
                  Signing with it proves the blob unlocks on the same device.
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
              <p style={{ margin: 0, color: "var(--muted)" }}>Connect your Ledger to begin.</p>
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

export default function LedgerPage() {
  // lockOnHide: false — the device confirmation can briefly background the tab;
  // with lockOnHide:true the vault would lock before signing returns.
  // walletGen: just a Solana signing agent so there's exactly one embedded blob
  // to demonstrate (the Ledger itself is the funds identity).
  return (
    <AuthProvider
      apiBaseUrl="/api/auth"
      config={{ appId: APP_ID, autoLockMs: 120_000, lockOnHide: false }}
      walletGen={{ solana: ["signing"] }}
    >
      <LedgerInner />
    </AuthProvider>
  );
}
