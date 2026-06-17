import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyticsRoute } from '../api/routes/analytics.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB, user-scoped routes via app.inject + a real JWT. Proves Slice 4.2a:
// the analytics aggregations return THIS ORG's figures only (RLS isolation), correctly split
// real-sends vs dry-run, and never leak another org's campaigns/credits. No LLM, no Smartlead.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

interface Org {
  orgId: string;
  userId: string;
  email: string;
  token: string;
  campaignId: string;
}

describe.skipIf(!ready)('Slice 4.2a — analytics aggregation (org-scoped, real-vs-dry)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const a: Org = {
    orgId: '',
    userId: '',
    email: `an-a+${stamp}@example.com`,
    token: '',
    campaignId: '',
  };
  const b: Org = {
    orgId: '',
    userId: '',
    email: `an-b+${stamp}@example.com`,
    token: '',
    campaignId: '',
  };

  async function makeOrg(o: Org, tag: string) {
    const org = await admin
      .from('organizations')
      .insert({ name: `an-${tag}-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    o.orgId = org.data.id as string;
    const pwd = `Test-${stamp}-pw!`;
    const created = await admin.auth.admin.createUser({
      email: o.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    o.userId = created.data.user.id;
    await admin
      .from('users')
      .insert({ id: o.userId, organization_id: o.orgId, email: o.email, role: 'owner' });
    const signin = await anon.auth.signInWithPassword({ email: o.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    o.token = signin.data.session.access_token;
    const c = await admin
      .from('campaigns')
      .insert({
        organization_id: o.orgId,
        name: `Camp ${tag}`,
        campaign_type: 'cold_outbound',
        status: 'active',
      })
      .select('id')
      .single();
    if (c.error) throw c.error;
    o.campaignId = c.data.id as string;
  }

  // Seed: person → thread → enrollment → outbound/inbound messages (enrollment_id set so byCampaign
  // resolves). Returns the enrollment id. `outbound` = list of statuses, `inboundPositive` = count.
  async function seed(o: Org, tag: string, outbound: string[], inboundCategories: string[]) {
    const p = await admin
      .from('people')
      .insert({
        organization_id: o.orgId,
        provider: 'seed',
        external_id: `an:${tag}:${stamp}`,
        full_name: 'Lead',
        email: `an-${tag}+${stamp}@x.com`,
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (p.error) throw p.error;
    const t = await admin
      .from('threads')
      .insert({
        organization_id: o.orgId,
        campaign_id: o.campaignId,
        lead_type: 'person',
        lead_id: p.data.id,
        status: 'active',
      })
      .select('id')
      .single();
    if (t.error) throw t.error;
    const e = await admin
      .from('enrollments')
      .insert({
        organization_id: o.orgId,
        campaign_id: o.campaignId,
        lead_type: 'person',
        lead_id: p.data.id,
        status: 'sent',
        current_step: 1,
        thread_id: t.data.id,
      })
      .select('id')
      .single();
    if (e.error) throw e.error;
    const enrollmentId = e.data.id as string;
    let i = 0;
    for (const status of outbound) {
      i += 1;
      const m = await admin.from('messages').insert({
        organization_id: o.orgId,
        thread_id: t.data.id,
        enrollment_id: enrollmentId,
        direction: 'outbound',
        channel: 'email',
        status,
        dedupe_key: `an:${tag}:out:${i}:${stamp}`,
      });
      if (m.error) throw m.error;
    }
    for (const category of inboundCategories) {
      i += 1;
      const m = await admin.from('messages').insert({
        organization_id: o.orgId,
        thread_id: t.data.id,
        enrollment_id: enrollmentId,
        direction: 'inbound',
        channel: 'email',
        status: 'replied',
        category,
        dedupe_key: `an:${tag}:in:${i}:${stamp}`,
      });
      if (m.error) throw m.error;
    }
  }

  beforeAll(async () => {
    await makeOrg(a, 'a');
    await makeOrg(b, 'b');
    // Org A: 1 dry_run + 1 sent outbound, 1 interested + 1 not_interested inbound; +100 grant, -1 send.
    await seed(a, 'a', ['dry_run', 'sent'], ['interested', 'not_interested']);
    await admin.from('credit_ledger').insert([
      {
        organization_id: a.orgId,
        delta: 100,
        reason: 'signup_grant',
        idempotency_key: `an-a-grant:${stamp}`,
      },
      {
        organization_id: a.orgId,
        delta: -1,
        reason: 'send',
        idempotency_key: `an-a-send:${stamp}`,
      },
    ]);
    // Org B: DIFFERENT data (2 sent, 1 interested) + a fat grant — must NEVER appear in A's figures.
    await seed(b, 'b', ['sent', 'sent'], ['interested']);
    await admin.from('credit_ledger').insert({
      organization_id: b.orgId,
      delta: 999,
      reason: 'signup_grant',
      idempotency_key: `an-b-grant:${stamp}`,
    });
  }, 180_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  async function get(url: string, token?: string) {
    const app = Fastify();
    await app.register(analyticsRoute);
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const res = await app.inject({ method: 'GET', url, headers });
    await app.close();
    return res;
  }

  it('overview: org A sees only its own counts (real-vs-dry split, replies, positive)', async () => {
    const res = await get('/analytics/overview', a.token);
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as {
      data: { realSends: number; kpis: Record<string, number> };
    };
    expect(data.kpis.draftsGenerated).toBe(2); // dry_run + sent
    expect(data.kpis.realSends).toBe(1); // only the non-dry_run (NOT B's 2)
    expect(data.realSends).toBe(1);
    expect(data.kpis.replies).toBe(2);
    expect(data.kpis.positiveReplies).toBe(1); // A's one 'interested' (NOT B's)
    expect(data.kpis.leadsEnrolled).toBe(1);
  }, 60_000);

  it('messaging: byStatus + byCampaign are org A only (B’s campaign absent)', async () => {
    const res = await get('/analytics/messaging', a.token);
    const { data } = res.json() as {
      data: {
        byStatus: Record<string, number>;
        byCampaign: { campaignId: string; drafts: number; sent: number; replies: number }[];
      };
    };
    expect(data.byStatus.dry_run).toBe(1);
    expect(data.byStatus.sent).toBe(1);
    expect(data.byCampaign).toHaveLength(1);
    expect(data.byCampaign[0]?.campaignId).toBe(a.campaignId);
    expect(data.byCampaign[0]).toMatchObject({ drafts: 2, sent: 1, replies: 2 });
    // B's campaign must never leak into A's breakdown.
    expect(data.byCampaign.some((r) => r.campaignId === b.campaignId)).toBe(false);
  }, 60_000);

  it('credits: balance is org A only (excludes B’s 999 grant)', async () => {
    const res = await get('/analytics/credits', a.token);
    const { data } = res.json() as { data: { balance: number; byReason: Record<string, number> } };
    expect(data.balance).toBe(99); // 100 - 1; NOT 99 + 999
    expect(data.byReason.send).toBe(-1);
  }, 60_000);

  it('rejects an unauthenticated request', async () => {
    const res = await get('/analytics/overview');
    expect(res.statusCode).toBe(401);
  });
});
