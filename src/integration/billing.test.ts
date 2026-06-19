import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingRoute } from '../api/routes/billing.js';
import { creditsRoute } from '../api/routes/credits.js';
import { questsRoute } from '../api/routes/quests.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Exercises the 4.10 quest engine + billing shell against a live DB via
// app.inject with a real JWT. Proves: quests pay REAL credits derived from REAL state, exactly once
// (idempotent); one org's reconcile never awards another; the billing route is an honest shell that
// writes NO ledger row and never fabricates a balance.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

interface QuestData {
  quests: { key: string; reward: number; done: boolean; awarded: boolean }[];
  completed: number;
  total: number;
  creditsEarned: number;
}
interface BillingData {
  plan: string;
  tiers: { tier: string }[];
  balance: number;
  lowBalance: boolean;
  topUpConfigured: boolean;
}

async function buildApp() {
  const app = Fastify();
  await app.register(questsRoute);
  await app.register(billingRoute);
  await app.register(creditsRoute);
  return app;
}

describe.skipIf(!ready)('4.10 — quests pay real credits + honest billing shell', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const acct = { orgId: '', userId: '', email: `bill+${stamp}@example.com`, token: '' };
  let orgB = '';

  beforeAll(async () => {
    const org = await admin
      .from('organizations')
      .insert({ name: `bill-${stamp}` })
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

    // Org B also has a completable quest (autopilot) — used to prove A's reconcile never awards B.
    const ob = await admin
      .from('organizations')
      .insert({ name: `billB-${stamp}` })
      .select('id')
      .single();
    if (ob.error) throw ob.error;
    orgB = ob.data.id as string;
    await admin.from('organizations').update({ autonomy_enabled: true }).eq('id', orgB);
  }, 180_000);

  afterAll(async () => {
    if (acct.orgId) await admin.from('organizations').delete().eq('id', acct.orgId);
    if (orgB) await admin.from('organizations').delete().eq('id', orgB);
    if (acct.userId) await admin.auth.admin.deleteUser(acct.userId);
  });

  it('a fresh org completes 0 quests and earns 0 credits (nothing fabricated)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/quests',
      headers: { authorization: `Bearer ${acct.token}` },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: QuestData };
    expect(data.total).toBe(14);
    expect(data.completed).toBe(0);
    expect(data.creditsEarned).toBe(0);
    expect(data.quests.every((q) => !q.done && !q.awarded)).toBe(true);

    // No quest_reward rows written for a fresh org.
    const led = await admin
      .from('credit_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', acct.orgId)
      .eq('reason', 'quest_reward');
    expect(led.count ?? 0).toBe(0);
  }, 60_000);

  it('completing a quest (turn-on-autopilot) awards its credits exactly once — idempotent', async () => {
    // Real state change: flip the org's autonomy flag (the autopilot quest's real completion signal).
    await admin.from('organizations').update({ autonomy_enabled: true }).eq('id', acct.orgId);

    const app = await buildApp();
    const first = await app.inject({
      method: 'GET',
      url: '/quests',
      headers: { authorization: `Bearer ${acct.token}` },
    });
    const d1 = (first.json() as { data: QuestData }).data;
    const autopilot = d1.quests.find((q) => q.key === 'turn-on-autopilot');
    expect(autopilot?.done).toBe(true);
    expect(autopilot?.awarded).toBe(true);
    expect(d1.completed).toBe(1);
    expect(d1.creditsEarned).toBe(autopilot?.reward);

    // Reconcile again — must NOT double-pay.
    const second = await app.inject({
      method: 'GET',
      url: '/quests',
      headers: { authorization: `Bearer ${acct.token}` },
    });
    await app.close();
    const d2 = (second.json() as { data: QuestData }).data;
    expect(d2.creditsEarned).toBe(d1.creditsEarned);

    // Exactly one quest_reward ledger row for this org+quest.
    const led = await admin
      .from('credit_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', acct.orgId)
      .eq('reason', 'quest_reward');
    expect(led.count ?? 0).toBe(1);
  }, 60_000);

  it('org A’s reconcile never awards org B (cross-tenant isolation)', async () => {
    // After A has reconciled above, B (also autopilot-complete but never reconciled by A) has no rows.
    const ledB = await admin
      .from('credit_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgB)
      .eq('reason', 'quest_reward');
    expect(ledB.count ?? 0).toBe(0);
  }, 60_000);

  it('GET /billing is an honest shell — real plan/balance, top-up disabled, writes nothing', async () => {
    // Snapshot the ledger row count, then call /billing, then confirm it is unchanged.
    const before = await admin
      .from('credit_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', acct.orgId);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/billing',
      headers: { authorization: `Bearer ${acct.token}` },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: BillingData };
    expect(data.plan).toBe('starter');
    expect(data.tiers.map((t) => t.tier)).toEqual(['starter', 'growth', 'scale']);
    expect(data.topUpConfigured).toBe(false);
    // Balance = the +400 autopilot award; ≥ threshold so not low.
    expect(data.balance).toBe(400);
    expect(data.lowBalance).toBe(false);

    const after = await admin
      .from('credit_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', acct.orgId);
    expect(after.count ?? 0).toBe(before.count ?? 0); // no fabricated credits
  }, 60_000);

  it('rejects unauthenticated requests on both routes', async () => {
    const app = await buildApp();
    const q = await app.inject({ method: 'GET', url: '/quests' });
    const b = await app.inject({ method: 'GET', url: '/billing' });
    await app.close();
    expect(q.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
  });
});
