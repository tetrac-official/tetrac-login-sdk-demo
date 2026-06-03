import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "TTC Login SDK — Demo",
  description:
    "Three ways to sign in: email & passkey, crypto wallet, or biometric. Your wallet is created and encrypted on your device.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
