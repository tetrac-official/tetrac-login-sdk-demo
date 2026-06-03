// Single storage instance shared by the auth route handlers.
//
// Zero-config demo default: an in-memory store (persists for the life of the dev
// server process). If any backend env var is present, the SDK auto-selects the
// real adapter (Redis locally, Vercel KV / Upstash in production).
import { MemoryAdapter, resolveStorageAdapter, type StorageAdapter } from "@tetrac/login-sdk/storage";

const useRealBackend =
  !!process.env.REDIS_URL ||
  !!process.env.VERCEL ||
  !!process.env.KV_REST_API_URL ||
  !!process.env.UPSTASH_REDIS_REST_URL;

// Top-level await is supported in Next server modules.
export const storage: StorageAdapter = useRealBackend ? await resolveStorageAdapter() : new MemoryAdapter();
