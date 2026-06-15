import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeSend, prepareEnrollment } from '../agents/sending/pipeline.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// Opt-in (RUN_DB_IT=1) — live DB + one real Anthropic draft (a few cents). NO email; the send
// path is dry-run (org flags default disabled + dry_run on). No Smartlead.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY &&
  !!env.ANTHROPIC_API_KEY &&
  !!env.OPENAI_API_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('Slice 2.3 live — gated send pipeline (DRY-RUN)', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a = { orgId: '', userId: '', email: `s23+${stamp}-a@example.com`, token: '' };
  const b = { orgId: '', userId: '', email: `s23+${stamp}-b@example.com`, token: '' };
  let campaignId = '';
  let goodEnrollId = '';
  let suppressedEnrollId = '';

  function userDb(token: string) {
    const db = createUserClient(token);
    if (!db) throw new Error('user-scoped client unavailable');
    return db;
  }

  async function makeOrgUser(o: { orgId: string; userId: string; email: string; token: string }) {
    const org = await admin
      .from('organizations')
      .insert({ name: `s23-${stamp}` })
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

  async function enroll(leadId: string): Promise<string> {
    const e = await admin
      .from('enrollments')
      .insert({
        organization_id: a.orgId,
        campaign_id: campaignId,
        lead_type: 'person',
        lead_id: leadId,
        status: 'pending',
      })
      .select('id')
      .single();
    if (e.error) throw e.error;
    return e.data.id as string;
  }

  beforeAll(async () => {
    await makeOrgUser(a);
    await makeOrgUser(b);
    // KB so the draft can ground.
    await admin
      .from('coaching_points')
      .insert({ organization_id: a.orgId, content: 'Value-first, concise, one CTA.' });
    await admin.from('proof_items').insert({
      organization_id: a.orgId,
      category: 'customer',
      title: 'Acme',
      body: 'Helped a SaaS team ship faster.',
    });
    // A rich, emailed lead (proceeds) + a suppressed lead.
    const good = await admin
      .from('people')
      .insert({
        organization_id: a.orgId,
        provider: 'seed',
        external_id: `s23good:${stamp}`,
        first_name: 'Jordan',
        full_name: 'Jordan Lee',
        email: `jordan+${stamp}@example.com`,
        title: 'CTO',
        company_name: 'Nimbus Labs',
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (good.error) throw good.error;
    const supEmail = `supp+${stamp}@example.com`;
    const sup = await admin
      .from('people')
      .insert({
        organization_id: a.orgId,
        provider: 'seed',
        external_id: `s23supp:${stamp}`,
        full_name: 'Pat Supp',
        email: supEmail,
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (sup.error) throw sup.error;
    await admin
      .from('suppression_list')
      .insert({ organization_id: a.orgId, email: supEmail, reason: 'unsubscribe' });
    // A campaign to attach enrollments to.
    const camp = await admin
      .from('campaigns')
      .insert({
        organization_id: a.orgId,
        name: 'DryRun',
        campaign_type: 'cold_outbound',
        status: 'active',
      })
      .select('id')
      .single();
    if (camp.error) throw camp.error;
    campaignId = camp.data.id as string;
    goodEnrollId = await enroll(good.data.id as string);
    suppressedEnrollId = await enroll(sup.data.id as string);
  }, 120_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('SUPPRESSION gate: a suppressed lead → unsubscribed, no task, no draft spend', async () => {
    const enr = (await admin.from('enrollments').select('*').eq('id', suppressedEnrollId).single())
      .data;
    const res = await prepareEnrollment(userDb(a.token), enr as never);
    expect(res.outcome).toBe('suppressed');
    const after = await admin
      .from('enrollments')
      .select('status, task_id')
      .eq('id', suppressedEnrollId)
      .single();
    expect(after.data?.status).toBe('unsubscribed');
    expect(after.data?.task_id).toBeNull();
  }, 60_000);

  it('PREPARE (real draft) → task awaiting_approval; APPROVE → dry-run message, NO provider send', async () => {
    const dbA = userDb(a.token);
    const enr = (await admin.from('enrollments').select('*').eq('id', goodEnrollId).single()).data;
    const prep = await prepareEnrollment(dbA, enr as never);
    expect(prep.outcome).toBe('prepared');
    expect(prep.taskId).toBeTruthy();

    const enrAfter = await admin
      .from('enrollments')
      .select('status, task_id')
      .eq('id', goodEnrollId)
      .single();
    expect(enrAfter.data?.status).toBe('awaiting_approval');
    const taskId = enrAfter.data?.task_id as string;

    // Approve the task, then run the chokepoint (mirrors the approve route).
    await dbA.from('tasks').update({ status: 'approved' }).eq('id', taskId);
    const enr2 = (await admin.from('enrollments').select('*').eq('id', goodEnrollId).single()).data;
    const sent = await executeSend(dbA, enr2 as never);
    expect(sent.outcome).toBe('dry_run');

    const msg = await admin.from('messages').select('*').eq('id', sent.messageId).single();
    expect(msg.data?.status).toBe('dry_run');
    expect(msg.data?.direction).toBe('outbound');
    expect(msg.data?.smartlead_message_id).toBeNull(); // nothing was pushed to a provider
    expect((msg.data?.gates as { mode?: string })?.mode).toBe('dry_run');
    expect(String(msg.data?.body ?? '').length).toBeGreaterThan(0);

    const finalEnr = await admin
      .from('enrollments')
      .select('status')
      .eq('id', goodEnrollId)
      .single();
    expect(finalEnr.data?.status).toBe('sent');

    // Idempotent re-send → no duplicate message (dedupe_key).
    await executeSend(dbA, enr2 as never);
    const count = await admin.from('messages').select('id').eq('enrollment_id', goodEnrollId);
    expect((count.data ?? []).length).toBe(1);
  }, 90_000);

  it('CROSS-TENANT: org B cannot read org A’s threads or messages', async () => {
    const dbB = userDb(b.token);
    expect(((await dbB.from('threads').select('id')).data ?? []).length).toBe(0);
    expect(((await dbB.from('messages').select('id')).data ?? []).length).toBe(0);
  }, 30_000);
});
