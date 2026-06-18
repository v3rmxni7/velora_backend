import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { campaignsRoute } from '../api/routes/campaigns.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB, routes via app.inject + real JWTs. Proves Slice 4.4a: variant CRUD
// (draft-only), deterministic cohort assignment at launch + re-launch stability, and cross-tenant
// denial. No LLM (launch only enrolls — it does not draft), no Smartlead, no real email.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

interface Acct {
  orgId: string;
  userId: string;
  email: string;
  token: string;
}

describe.skipIf(!ready)('Slice 4.4a — campaign variants (A/Z cohort assignment + CRUD)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const a: Acct = { orgId: '', userId: '', email: `cv-a+${stamp}@example.com`, token: '' };
  const b: Acct = { orgId: '', userId: '', email: `cv-b+${stamp}@example.com`, token: '' };
  let campaignId = '';
  let listId = '';

  async function makeAcct(o: Acct, tag: string) {
    const org = await admin
      .from('organizations')
      .insert({ name: `cv-${tag}-${stamp}` })
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
  }

  async function inject(method: 'POST' | 'PUT', url: string, token: string, payload?: unknown) {
    const app = Fastify();
    await app.register(campaignsRoute);
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    await app.close();
    return res;
  }

  const enrollmentsByLead = async () => {
    const r = await admin
      .from('enrollments')
      .select('lead_id, variant_id')
      .eq('campaign_id', campaignId);
    if (r.error) throw r.error;
    return new Map((r.data ?? []).map((e) => [e.lead_id as string, e.variant_id as string | null]));
  };

  beforeAll(async () => {
    await makeAcct(a, 'a');
    await makeAcct(b, 'b');
    const list = await admin
      .from('lists')
      .insert({ organization_id: a.orgId, name: 'CV list', entity_type: 'person' })
      .select('id')
      .single();
    if (list.error) throw list.error;
    listId = list.data.id as string;
    for (let i = 0; i < 4; i++) {
      const p = await admin
        .from('people')
        .insert({
          organization_id: a.orgId,
          provider: 'seed',
          external_id: `cv:${i}:${stamp}`,
          full_name: `Lead ${i}`,
          email: `cv${i}+${stamp}@x.com`,
          source: 'find_leads',
        })
        .select('id')
        .single();
      if (p.error) throw p.error;
      const lm = await admin.from('list_members').insert({
        organization_id: a.orgId,
        list_id: listId,
        entity_type: 'person',
        entity_id: p.data.id,
      });
      if (lm.error) throw lm.error;
    }
    const c = await admin
      .from('campaigns')
      .insert({
        organization_id: a.orgId,
        name: 'CV',
        campaign_type: 'cold_outbound',
        status: 'draft',
        list_id: listId,
      })
      .select('id')
      .single();
    if (c.error) throw c.error;
    campaignId = c.data.id as string;
  }, 180_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('PUT /variants authors 2 variants on a draft campaign', async () => {
    const res = await inject('PUT', `/campaigns/${campaignId}/variants`, a.token, {
      variants: [
        { label: 'A', angle: 'lead with the pain point' },
        { label: 'B', angle: 'lead with peer social proof' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const vs = await admin.from('campaign_variants').select('label').eq('campaign_id', campaignId);
    expect((vs.data ?? []).map((v) => v.label).sort()).toEqual(['A', 'B']);
  }, 60_000);

  it('launch assigns every enrollment a non-null variant cohort (deterministic, re-launch-stable)', async () => {
    const launch = await inject('POST', `/campaigns/${campaignId}/launch`, a.token);
    expect(launch.statusCode).toBe(200);
    const first = await enrollmentsByLead();
    expect(first.size).toBe(4);
    for (const variantId of first.values()) expect(variantId).toBeTruthy(); // every lead got a cohort

    // Re-launch → idempotent upsert keeps each lead's ORIGINAL variant (no reshuffle).
    const relaunch = await inject('POST', `/campaigns/${campaignId}/launch`, a.token);
    expect(relaunch.statusCode).toBe(200);
    const second = await enrollmentsByLead();
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
  }, 90_000);

  it('variants are LOCKED once the campaign is launched (422)', async () => {
    // campaign is now 'active' from the previous test.
    const res = await inject('PUT', `/campaigns/${campaignId}/variants`, a.token, {
      variants: [{ label: 'A', angle: 'changed' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'variants_locked' });
  }, 60_000);

  it('cross-tenant: org B cannot author org A’s variants (404)', async () => {
    const res = await inject('PUT', `/campaigns/${campaignId}/variants`, b.token, {
      variants: [{ label: 'X', angle: 'nope' }],
    });
    expect(res.statusCode).toBe(404);
    // And org B cannot even read A's variants under RLS.
    const bClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: `Bearer ${b.token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const leak = await bClient.from('campaign_variants').select('id').eq('campaign_id', campaignId);
    expect((leak.data ?? []).length).toBe(0);
  }, 60_000);
});
