// Single source of truth for the appId used across the demo.
// The AuthProvider config AND every direct SDK call that is appId-sensitive
// (walletAppKeyMessage, deriveAppKeyFromPasskey) must use the same value —
// changing it re-derives all keys and orphans existing encrypted wallets.
export const APP_ID = "ttc-demo";
