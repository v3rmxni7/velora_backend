import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeSend, prepareEnrollment } from '../agents/sending/pipeline.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';
import { verdictFromResult } from '../integrations/verifier/millionverifier.js';
import type { EmailVerifier } from '../integrations/verifier/types.js';

// Opt-in (RUN_DB_IT=1) — live DB, injected fake verifier + researcher stub → NO email, NO LLM.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const fakeVerifier = (result: string): EmailVerifier => ({
  async verify() {
    return { result, verdict: verdictFromResult(result) };
  },
});
const noFacts = { researcher: async () => ({ facts: [], allowedRefs: new Set<string>() }) };

describe.skipIf(!ready)('Slice 2.4 live — email verification gate', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a = { orgId: '', userId: '', email: `s24+${stamp}@example.com`, token: '' };
  let campaignId = '';
  let invalidEnrollId = '';
  let okEnrollId = '';

  function userDb(token: string) {
    const db = createUserClient(token);
    if (!db) throw new Error('user-scoped client unavailable');
    return db;
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
  async function person(ext: string, email: string): Promise<string> {
    const p = await admin
      .from('people')
      .insert({
        organization_id: a.orgId,
        provider: 'seed',
        external_id: ext,
        full_name: 'Lead',
        email,
        title: 'CTO',
        company_name: 'Co',
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (p.error) throw p.error;
    return p.data.id as string;
  }

  beforeAll(async () => {
    const org = await admin
      .from('organizations')
      .insert({ name: `s24-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    a.orgId = org.data.id as string;
    const created = await admin.auth.admin.createUser({
      email: a.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    a.userId = created.data.user.id;
    await admin
      .from('users')
      .insert({ id: a.userId, organization_id: a.orgId, email: a.email, role: 'owner' });
    const signin = await anon.auth.signInWithPassword({ email: a.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    a.token = signin.data.session.access_token;

    await admin
      .from('coaching_points')
      .insert({ organization_id: a.orgId, content: 'concise, value-first' });
    const camp = await admin
      .from('campaigns')
      .insert({
        organization_id: a.orgId,
        name: 'Verify',
        campaign_type: 'cold_outbound',
        status: 'active',
      })
      .select('id')
      .single();
    if (camp.error) throw camp.error;
    campaignId = camp.data.id as string;
    invalidEnrollId = await enroll(await person(`s24bad:${stamp}`, `bad+${stamp}@x.com`));
    okEnrollId = await enroll(await person(`s24ok:${stamp}`, `good+${stamp}@x.com`));
  }, 120_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
  });

  it('UNDELIVERABLE (invalid) → enrollment failed, no task, no draft spend', async () => {
    const enr = (await admin.from('enrollments').select('*').eq('id', invalidEnrollId).single())
      .data;
    const res = await prepareEnrollment(userDb(a.token), enr as never, {}, fakeVerifier('invalid'));
    expect(res.outcome).toBe('undeliverable');
    const after = await admin
      .from('enrollments')
      .select('status, error, task_id')
      .eq('id', invalidEnrollId)
      .single();
    expect(after.data?.status).toBe('failed');
    expect(after.data?.error).toBe('email_invalid');
    expect(after.data?.task_id).toBeNull();
  }, 60_000);

  it('DELIVERABLE (ok) → proceeds, verified_email + verdict stored; verdict reaches the send gates', async () => {
    const dbA = userDb(a.token);
    const enr = (await admin.from('enrollments').select('*').eq('id', okEnrollId).single()).data;
    const res = await prepareEnrollment(dbA, enr as never, noFacts, fakeVerifier('ok'));
    expect(res.outcome).toBe('prepared');
    const after = await admin
      .from('enrollments')
      .select('status, verified_email, verification, task_id')
      .eq('id', okEnrollId)
      .single();
    expect(after.data?.status).toBe('awaiting_approval');
    expect(after.data?.verified_email).toBe(`good+${stamp}@x.com`);
    expect(after.data?.verification).toBe('deliverable');

    // Approve + send → the message's gates blob carries the ACTUAL verdict (not a boolean).
    await dbA.from('tasks').update({ status: 'approved' }).eq('id', after.data?.task_id);
    const enr2 = (await admin.from('enrollments').select('*').eq('id', okEnrollId).single()).data;
    const sent = await executeSend(dbA, enr2 as never);
    expect(sent.outcome).toBe('dry_run');
    const msg = await admin.from('messages').select('gates').eq('id', sent.messageId).single();
    expect((msg.data?.gates as { verification?: string })?.verification).toBe('deliverable');
  }, 60_000);
});
