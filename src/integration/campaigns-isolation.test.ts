import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchCampaign } from '../agents/sending/enroll.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// Opt-in (RUN_DB_IT=1) — live DB only. No email, no LLM.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('Slice 2.2 live — campaign launch + enrollment isolation', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a = { orgId: '', userId: '', email: `s22+${stamp}-a@example.com`, token: '' };
  const b = { orgId: '', userId: '', email: `s22+${stamp}-b@example.com`, token: '' };
  let listId = '';
  let campaignId = '';

  function userDb(token: string) {
    const db = createUserClient(token);
    if (!db) throw new Error('user-scoped client unavailable');
    return db;
  }

  async function makeOrgUser(o: { orgId: string; userId: string; email: string; token: string }) {
    const org = await admin
      .from('organizations')
      .insert({ name: `s22-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    o.orgId = org.data.id as string;
    const created = await admin.auth.admin.createUser({
      email: o.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser failed');
    o.userId = created.data.user.id;
    const link = await admin
      .from('users')
      .insert({ id: o.userId, organization_id: o.orgId, email: o.email, role: 'owner' });
    if (link.error) throw link.error;
    const signin = await anon.auth.signInWithPassword({ email: o.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin failed');
    o.token = signin.data.session.access_token;
  }

  beforeAll(async () => {
    await makeOrgUser(a);
    await makeOrgUser(b);
    // Org A: a person list + 3 people + 3 members.
    const list = await admin
      .from('lists')
      .insert({ organization_id: a.orgId, name: `L-${stamp}`, entity_type: 'person' })
      .select('id')
      .single();
    if (list.error) throw list.error;
    listId = list.data.id as string;
    for (let i = 1; i <= 3; i++) {
      const p = await admin
        .from('people')
        .insert({
          organization_id: a.orgId,
          provider: 'seed',
          external_id: `c22:${stamp}:${i}`,
          full_name: `Lead ${i}`,
          source: 'find_leads',
        })
        .select('id')
        .single();
      if (p.error) throw p.error;
      const m = await admin.from('list_members').insert({
        organization_id: a.orgId,
        list_id: listId,
        entity_type: 'person',
        entity_id: p.data.id,
      });
      if (m.error) throw m.error;
    }
  }, 120_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('create campaign (+ auto step 1) then launch → 3 pending enrollments; re-launch idempotent', async () => {
    const dbA = userDb(a.token);
    const camp = await dbA
      .from('campaigns')
      .insert({
        organization_id: a.orgId,
        name: 'Cold Q3',
        campaign_type: 'cold_outbound',
        list_id: listId,
        status: 'draft',
      })
      .select('id, organization_id, list_id')
      .single();
    if (camp.error || !camp.data) throw camp.error ?? new Error('campaign insert failed');
    campaignId = camp.data.id as string;
    await dbA.from('campaign_steps').insert({
      organization_id: a.orgId,
      campaign_id: campaignId,
      step_number: 1,
      channel: 'email',
      body_mode: 'ai_grounded',
    });

    const first = await launchCampaign(dbA, {
      id: campaignId,
      organization_id: a.orgId,
      list_id: listId,
    });
    expect(first.enrolled).toBe(3);
    const e1 = await dbA.from('enrollments').select('status').eq('campaign_id', campaignId);
    expect((e1.data ?? []).length).toBe(3);
    expect((e1.data ?? []).every((r) => r.status === 'pending')).toBe(true);

    // idempotent re-launch — still 3 total
    await launchCampaign(dbA, { id: campaignId, organization_id: a.orgId, list_id: listId });
    const e2 = await dbA.from('enrollments').select('id').eq('campaign_id', campaignId);
    expect((e2.data ?? []).length).toBe(3);

    // campaign flipped to active
    const c = await dbA.from('campaigns').select('status').eq('id', campaignId).single();
    expect(c.data?.status).toBe('active');
  }, 60_000);

  it('CROSS-TENANT: org B sees none of org A’s campaigns/enrollments and cannot enroll org A’s leads', async () => {
    const dbB = userDb(b.token);
    expect(((await dbB.from('campaigns').select('id')).data ?? []).length).toBe(0);
    expect(((await dbB.from('enrollments').select('id')).data ?? []).length).toBe(0);
    // org B launching with org A's list_id reads 0 members under RLS → enrolls nothing into A
    const res = await launchCampaign(dbB, {
      id: campaignId,
      organization_id: b.orgId,
      list_id: listId,
    });
    expect(res.enrolled).toBe(0);
    const aStill = await userDb(a.token)
      .from('enrollments')
      .select('id')
      .eq('campaign_id', campaignId);
    expect((aStill.data ?? []).length).toBe(3); // unchanged
  }, 60_000);
});
