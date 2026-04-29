import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _server: SupabaseClient | null = null;
let _anon: SupabaseClient | null = null;

/**
 * Bypass Next.js App Router's default fetch caching.
 *
 * The App Router caches fetch() calls inside server components by default.
 * `export const dynamic = "force-dynamic"` controls when the route renders
 * but does NOT change the per-fetch cache policy. Without this override,
 * the Supabase client's underlying fetch() calls return the FIRST observed
 * response for a given URL+headers indefinitely — so a row mutated by a
 * client-side POST (e.g. /post-call moving state nudge_sent → received)
 * is invisible to subsequent server-side reads, leaving the case page
 * stuck on stale state until a redeploy.
 *
 * Passing { cache: "no-store" } on every Supabase fetch fixes this. The
 * pattern is the official Supabase + Next.js App Router recommendation.
 */
const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

/** Server-side client with service_role — full DB + storage access. Never expose to browser. */
export function supabaseServer(): SupabaseClient {
  if (_server) return _server;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase server client: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  _server = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: noStoreFetch },
  });
  return _server;
}

/** Anon client for browser use — RLS-bound. */
export function supabaseAnon(): SupabaseClient {
  if (_anon) return _anon;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Supabase anon client: SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  }
  _anon = createClient(url, key, {
    global: { fetch: noStoreFetch },
  });
  return _anon;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.SUPABASE_ANON_KEY
  );
}
