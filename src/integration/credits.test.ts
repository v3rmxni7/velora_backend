import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { creditsRoute } from '../api/routes/credits.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). User-scoped route via app.inject + a real JWT. Verifies the credits
// balance is this org's own ledger sum — and that another org's ledger never leaks in.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

interface CreditsData {
  balance: number;
  granted: number;
  used: number;
}

describe.skipIf(!ready)('GET /credits — org-scoped balance (no cross-tenant leak)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const acct = { orgId: '', userId: '', email: `cred+${stamp}@example.com`, token: '' };
  let orgB = '';

  beforeAll(async () => {
    const org = await admin
      .from('organizations')
      .insert({ name: `cred-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    acct.orgId = org.data.id as string;

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

    // org A ledger: +100 grant, -1 send, -2 send → granted 100, used 3, balance 97.
    const led = await admin.from('credit_ledger').insert([
      {
        organization_id: acct.orgId,
        delta: 100,
        reason: 'signup_grant',
        idempotency_key: `grant:${stamp}`,
      },
      { organization_id: acct.orgId, delta: -1, reason: 'send', idempotency_key: `s1:${stamp}` },
      { organization_id: acct.orgId, delta: -2, reason: 'send', idempotency_key: `s2:${stamp}` },
    ]);
    if (led.error) throw led.error;

    // org B: a large grant that MUST NOT leak into org A's balance.
    const ob = await admin
      .from('organizations')
      .insert({ name: `credB-${stamp}` })
      .select('id')
      .single();
    if (ob.error) throw ob.error;
    orgB = ob.data.id as string;
    const ledB = await admin.from('credit_ledger').insert({
      organization_id: orgB,
      delta: 5000,
      reason: 'signup_grant',
      idempotency_key: `grantB:${stamp}`,
    });
    if (ledB.error) throw ledB.error;
  }, 180_000);

  afterAll(async () => {
    if (acct.orgId) await admin.from('organizations').delete().eq('id', acct.orgId);
    if (orgB) await admin.from('organizations').delete().eq('id', orgB);
    if (acct.userId) await admin.auth.admin.deleteUser(acct.userId);
  });

  it('returns this org’s balance/granted/used (org B’s 5000 does not leak)', async () => {
    const app = Fastify();
    await app.register(creditsRoute);
    const res = await app.inject({
      method: 'GET',
      url: '/credits',
      headers: { authorization: `Bearer ${acct.token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: CreditsData };
    expect(data.granted).toBe(100);
    expect(data.used).toBe(3);
    expect(data.balance).toBe(97);
  }, 60_000);

  it('rejects an unauthenticated request', async () => {
    const app = Fastify();
    await app.register(creditsRoute);
    const res = await app.inject({ method: 'GET', url: '/credits' });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});
