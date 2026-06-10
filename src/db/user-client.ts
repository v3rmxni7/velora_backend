import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

let anon: SupabaseClient | null = null;

/**
 * Shared anon-key client used only to validate a user's JWT (auth.getUser).
 * Returns null when Supabase creds are absent.
 */
export function getSupabaseAnon(): SupabaseClient | null {
  if (anon) return anon;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return anon;
}

/**
 * Per-request, USER-SCOPED client: anon key + the caller's JWT in the
 * Authorization header, so every query runs as that user and Postgres RLS (via
 * public.auth_organization_id()) enforces tenant isolation.
 *
 * This is the ONLY client a user-facing route handler should touch. The
 * service-role client (getSupabaseAdmin) bypasses RLS and is reserved for
 * trusted Inngest jobs. Returns null when Supabase creds are absent.
 */
export function createUserClient(accessToken: string): SupabaseClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
