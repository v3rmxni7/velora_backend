import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

let client: SupabaseClient | null = null;

/**
 * Lazy service-role Supabase client (backend-only; bypasses RLS — never expose
 * the service-role key to the frontend). Returns null when creds are absent so
 * Phase 0 boots and typechecks without a live database.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (client) return client;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
