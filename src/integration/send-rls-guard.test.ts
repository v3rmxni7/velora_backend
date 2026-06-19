import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// GUARD TEST (G1) — the send-safety LINCHPIN. The entire two-flag invariant rests on `organizations`
// having ONLY a SELECT RLS policy (no UPDATE policy), so sending_enabled / sending_dry_run cannot be
// flipped by any authenticated user — only the service-role/DB at a deliberate go-live. This test
// ENCODES that: an owner's UPDATE attempt must affect 0 rows and leave the flags default-safe. A
// future migration that added an UPDATE policy to organizations would make this test FAIL.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('send-safety linchpin — RLS denies flipping the sending flags', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const acct = { orgId: '', userId: '', email: `rlsguard+${stamp}@example.com`, token: '' };

  beforeAll(async () => {
    const org = await admin
      .from('organizations')
      .insert({ name: `rlsguard-${stamp}` })
      .select('id, sending_enabled, sending_dry_run')
      .single();
    if (org.error) throw org.error;
    acct.orgId = org.data.id as string;
    // Sanity: a new org is default-safe.
    expect(org.data.sending_enabled).toBe(false);
    expect(org.data.sending_dry_run).toBe(true);

    const pwd = `Test-${stamp}-pw!`;
    const created = await admin.auth.admin.createUser({
      email: acct.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    acct.userId = created.data.user.id;
    await admin
      .from('users')
      .insert({ id: acct.userId, organization_id: acct.orgId, email: acct.email, role: 'owner' });
    const signin = await anon.auth.signInWithPassword({ email: acct.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    acct.token = signin.data.session.access_token;
  }, 180_000);

  afterAll(async () => {
    if (acct.orgId) await admin.from('organizations').delete().eq('id', acct.orgId);
    if (acct.userId) await admin.auth.admin.deleteUser(acct.userId);
  });

  it('an authenticated owner CANNOT flip sending_enabled / sending_dry_run (0 rows; flags unchanged)', async () => {
    const db = createUserClient(acct.token);
    if (!db) throw new Error('user client unavailable');

    // No UPDATE policy on organizations → the row is invisible to UPDATE under RLS → 0 rows affected.
    const upd = await db
      .from('organizations')
      .update({ sending_enabled: true, sending_dry_run: false })
      .eq('id', acct.orgId)
      .select('id');
    expect((upd.data ?? []).length).toBe(0);

    // The service-role read confirms the flags are STILL default-safe — the user could not flip them.
    const after = await admin
      .from('organizations')
      .select('sending_enabled, sending_dry_run')
      .eq('id', acct.orgId)
      .single();
    expect(after.data?.sending_enabled).toBe(false);
    expect(after.data?.sending_dry_run).toBe(true);
  }, 60_000);
});
