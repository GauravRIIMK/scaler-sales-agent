import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _server: SupabaseClient | null = null;
let _anon: SupabaseClient | null = null;

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
  _anon = createClient(url, key);
  return _anon;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.SUPABASE_ANON_KEY
  );
}
