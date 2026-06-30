import Image from "next/image";
import Link from "next/link";
import { Providers } from "./providers";
import { DemoShell } from "./components/DemoShell";
import { ArrowRightIcon, ShieldIcon } from "./components/icons";

// Inspired by openwallet.sh: minimal nav, version pill, bold headline,
// signature terminal mockup in the hero, and a numbered principles grid.
const principles = [
  {
    title: "Local-first",
    body: "Keys are generated, encrypted, and stored on your device. No backend escrow, no cloud HSM, no recovery server.",
  },
  {
    title: "Three doors, one model",
    body: "Email & passkey, crypto wallet, or biometric — each derives the same on-device encryption key.",
  },
  {
    title: "Multi-chain by default",
    body: "Solana and EVM wallets minted from a single account. One sign-in, every chain you ship.",
  },
  {
    title: "Zero plaintext at rest",
    body: "AES-256-GCM encryption with a key the SDK derives but never persists. Your secret never touches disk.",
  },
  {
    title: "Re-auth to reveal",
    body: "Showing or signing always requires a fresh proof — passkey, wallet signature, or Face ID / Touch ID.",
  },
  {
    title: "Headless or styled",
    body: "Drop in the prebuilt <LoginPanel /> from /ui, or wire your own UI to the headless useAuth() hook.",
  },
];

export default function Home() {
  return (
    <Providers>
      <nav className="nav" aria-label="Primary">
        <div className="nav-inner">
          <a href="#top" className="nav-brand" aria-label="tetrac login sdk">
            {/* Real brand mark — sits flush left, scaled tight to the wordmark. */}
            <Image src="/tetrac_dark.png" alt="" width={28} height={28} priority className="nav-logo" />
            tetrac<span className="nav-slash">/</span>
            <span className="grad">login-sdk</span>
          </a>

          {/* Section anchors — hidden on mobile to save space. */}
          <div className="nav-links" role="navigation">
            <a href="#methods">Methods</a>
            <a href="#principles">Principles</a>
            <a href="#install">Install</a>
          </div>

          <div className="nav-cta">
            {/* openwallet.sh-style icon-only GitHub link. PNG mark is black on
                transparent, so CSS inverts it to white on the dark nav. */}
            <a
              href="https://github.com/tetrac-official"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              title="GitHub"
              className="nav-btn nav-btn-icon"
            >
              <Image src="/github.png" alt="" width={24} height={24} className="nav-github" />
            </a>
          </div>
        </div>
      </nav>

      <main id="top" className="page">
        <header className="hero">
          <span className="eyebrow">
            <ShieldIcon /> v1.0 · Self-custodial · Open source
          </span>
          <h1>
            Three ways to <span className="grad">sign in.</span>
            <br />
            One self-custodial model.
          </h1>
          <p>
            Email & passkey, crypto wallet, or biometric. Whichever your users pick, the wallet is created and
            encrypted on their device — and your servers never see the key.
          </p>

          <div className="hero-actions">
            <a href="#methods" className="hero-btn hero-btn-primary">
              Try the demo
              <ArrowRightIcon />
            </a>
            <Link href="/ui" className="hero-btn hero-btn-outline">
              Open SDK UI
            </Link>
            <Link href="/bridge" className="hero-btn hero-btn-outline">
              External-wallet bridge
            </Link>
            <Link href="/biometric" className="hero-btn hero-btn-outline">
              Biometric unlock
            </Link>
            <Link href="/ledger" className="hero-btn hero-btn-outline">
              Ledger login
            </Link>
          </div>

          {/* Terminal mockup — the visual signature of the hero. */}
          <div className="terminal" role="img" aria-label="Install command snippet">
            <div className="terminal-bar">
              <span className="terminal-dot terminal-dot-r" />
              <span className="terminal-dot terminal-dot-y" />
              <span className="terminal-dot terminal-dot-g" />
              <span className="terminal-title">@tetrac/login-sdk</span>
            </div>
            <pre className="terminal-body">
              <code>
                <span className="t-line">
                  <span className="t-prompt">$</span> npm install @tetrac/login-sdk
                </span>
                <span className="t-line t-out">
                  <span className="t-ok">✓</span> installed · solana + evm · 0 servers required
                </span>
                <span className="t-line t-comment"># wrap your app once and you're done</span>
                <span className="t-line">
                  <span className="t-kw">import</span> {"{ AuthProvider }"} <span className="t-kw">from</span>{" "}
                  <span className="t-str">&quot;@tetrac/login-sdk/react&quot;</span>;
                </span>
              </code>
            </pre>
          </div>

          <div className="trust">
            <span>
              <ShieldIcon /> Keys stay on your device
            </span>
            <span>
              <ShieldIcon /> AES-256-GCM encrypted
            </span>
            <span>
              <ShieldIcon /> Solana + EVM
            </span>
          </div>
        </header>

        {/* The interactive demo. Anchored so the hero CTA can scroll to it. */}
        <section id="methods" aria-label="Try a sign-in method">
          <DemoShell />
        </section>

        {/* --- Numbered principles section (OWS-inspired) --- */}
        <section id="principles" className="principles">
          <div className="section-head">
            <p className="kicker">Built for self-custody</p>
            <h2>
              Six principles that make this SDK <span className="grad">different.</span>
            </h2>
            <p className="section-sub">
              No vendor servers, no centralized key escrow, no proprietary chain abstractions. Just a clean
              local model that wraps proven primitives.
            </p>
          </div>
          <ol className="principle-grid">
            {principles.map((p, i) => (
              <li key={p.title} className="principle-card">
                <span className="principle-num">{String(i + 1).padStart(2, "0")}</span>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* --- Quickstart install block --- */}
        <section id="install" className="install">
          <div className="section-head">
            <p className="kicker">From zero to signed in</p>
            <h2>Wire it up in 60 seconds.</h2>
            <p className="section-sub">
              No environment variables, no cloud setup, no SDK initialization ceremony. Install, provide,
              authenticate.
            </p>
          </div>

          <div className="install-grid">
            <div className="install-step">
              <span className="step-num">1</span>
              <div className="step-body">
                <h4>Install</h4>
                <pre className="install-snippet">
                  <code>
                    <span className="t-prompt">$</span> npm install @tetrac/login-sdk
                  </code>
                </pre>
              </div>
            </div>
            <div className="install-step">
              <span className="step-num">2</span>
              <div className="step-body">
                <h4>Wrap your app</h4>
                <pre className="install-snippet">
                  <code>
                    {"<"}
                    <span className="t-tag">AuthProvider</span>
                    {">{children}</"}
                    <span className="t-tag">AuthProvider</span>
                    {">"}
                  </code>
                </pre>
              </div>
            </div>
            <div className="install-step">
              <span className="step-num">3</span>
              <div className="step-body">
                <h4>Authenticate</h4>
                <pre className="install-snippet">
                  <code>
                    <span className="t-kw">const</span> auth = <span className="t-fn">useAuth</span>();
                    {"\n"}auth.<span className="t-fn">loginWithEmail</span>({"{ email, passkey }"});
                  </code>
                </pre>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Conversion CTA mirroring ttc.box's home hero. Lives outside .page so it
          can run full-bleed with its own black background and glow blobs. */}
      <section className="cta">
        <div className="cta-glow cta-glow-left" aria-hidden="true" />
        <div className="cta-glow cta-glow-right" aria-hidden="true" />
        <div className="cta-inner">
          <h2 className="cta-title">
            Trade everywhere from <span className="cta-accent">one login.</span>
          </h2>
          <p className="cta-sub">Trade with zero commission. Start in 30 seconds.</p>
          <div className="cta-actions">
            <a
              href="https://ttc.box/trading/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="cta-btn cta-btn-primary"
            >
              Start Trading
              <ArrowRightIcon />
            </a>
            <a
              href="https://ttc.box/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="cta-btn cta-btn-outline"
            >
              Read Documentation
            </a>
          </div>
        </div>
      </section>
    </Providers>
  );
}
