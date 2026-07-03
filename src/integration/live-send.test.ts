import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeSend, prepareEnrollment } from '../agents/sending/pipeline.js';
import { webhooksRoute } from '../api/routes/webhooks.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';
import type { SmartleadClient } from '../integrations/smartlead/types.js';
import { verdictFromResult } from '../integrations/verifier/millionverifier.js';

// Opt-in (RUN_DB_IT=1). Live DB, FAKE Smartlead client, flags flipped FOR THE TEST ORG ONLY,
// simulated webhook → NO real email, NO Smartlead, NO LLM (researcher stubbed). The demo org is
// never touched. The webhook sub-test also needs SMARTLEAD_WEBHOOK_SECRET set in the run.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const noFacts = { researcher: async () => ({ facts: [], allowedRefs: new Set<string>() }) };
const okVerifier = {
  async verify() {
    return { result: 'ok', verdict: verdictFromResult('ok') };
  },
};

describe.skipIf(!ready)('Slice 2.5 live — LIVE send via fake Smartlead (zero real email)', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a = { orgId: '', userId: '', email: `s25+${stamp}@example.com`, token: '' };
  let campaignId = '';
  let enrInsufficient = '';
  let enrSuccess = '';
  const leadBEmail = `leadb+${stamp}@example.com`;

  const addLeadCalls: { email: string; custom_fields: Record<string, string> }[] = [];
  const fake: SmartleadClient = {
    async listEmailAccounts() {
      return [];
    },
    async getWarmupStats() {
      return {};
    },
    async createCampaign() {
      return { id: `sl-camp-${stamp}` };
    },
    async saveSequence() {},
    async assignEmailAccounts() {},
    async setSchedule() {},
    async setStatus() {},
    async addLead(_c, lead) {
      addLeadCalls.push(lead);
    },
    async sendReply() {},
  };

  function userDb(token: string) {
    const db = createUserClient(token);
    if (!db) throw new Error('user-scoped client unavailable');
    return db;
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
  async function prepareAndApprove(enrId: string) {
    const dbA = userDb(a.token);
    const enr = (await admin.from('enrollments').select('*').eq('id', enrId).single()).data;
    await prepareEnrollment(dbA, enr as never, noFacts, okVerifier);
    const after = (await admin.from('enrollments').select('task_id').eq('id', enrId).single()).data;
    await dbA.from('tasks').update({ status: 'approved' }).eq('id', after?.task_id);
  }

  beforeAll(async () => {
    const org = await admin
      .from('organizations')
      .insert({ name: `s25-${stamp}` })
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

    await admin.from('coaching_points').insert({ organization_id: a.orgId, content: 'concise' });
    // A WARM mailbox so provisioning can assign a sender (2.8: only 'warm' qualifies).
    await admin.from('mailboxes').insert({
      organization_id: a.orgId,
      email: `mb+${stamp}@x.com`,
      smartlead_email_account_id: 'acct-1',
      status: 'warm',
    });
    const camp = await admin
      .from('campaigns')
      .insert({
        organization_id: a.orgId,
        name: 'Live',
        campaign_type: 'cold_outbound',
        status: 'active',
      })
      .select('id')
      .single();
    if (camp.error) throw camp.error;
    campaignId = camp.data.id as string;
    enrInsufficient = await enroll(await person(`s25ins:${stamp}`, `ins+${stamp}@x.com`));
    enrSuccess = await enroll(await person(`s25ok:${stamp}`, leadBEmail));
    await prepareAndApprove(enrInsufficient);
    await prepareAndApprove(enrSuccess);
    // THE DELIBERATE FLIP — for THIS test org only. Demo org is never touched.
    await admin
      .from('organizations')
      .update({ sending_enabled: true, sending_dry_run: false })
      .eq('id', a.orgId);
  }, 180_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
  });

  it('INSUFFICIENT credit (no grant) → failed, no push, no debit', async () => {
    const enr = (await admin.from('enrollments').select('*').eq('id', enrInsufficient).single())
      .data;
    const res = await executeSend(userDb(a.token), enr as never, fake);
    expect(res.outcome).toBe('insufficient_credit');
    const after = await admin
      .from('enrollments')
      .select('status, error')
      .eq('id', enrInsufficient)
      .single();
    expect(after.data?.status).toBe('failed');
    expect(after.data?.error).toBe('insufficient_credit');
    expect(addLeadCalls.length).toBe(0); // nothing pushed
  }, 60_000);

  it('LIVE send (fake push) → queued + smartlead campaign provisioned + exactly one credit debit; idempotent', async () => {
    // Grant credits.
    await admin.from('credit_ledger').insert({
      organization_id: a.orgId,
      delta: 100,
      reason: 'signup_grant',
      idempotency_key: `grant:${stamp}`,
    });
    const enr = (await admin.from('enrollments').select('*').eq('id', enrSuccess).single()).data;
    const res = await executeSend(userDb(a.token), enr as never, fake);
    expect(res.outcome).toBe('queued');

    const msg = await admin
      .from('messages')
      .select('status, smartlead_message_id, gates')
      .eq('id', res.messageId)
      .single();
    expect(msg.data?.status).toBe('queued');
    expect(msg.data?.smartlead_message_id).toBeNull(); // set on the EMAIL_SENT webhook
    expect((msg.data?.gates as { mode?: string })?.mode).toBe('live');

    const camp = await admin
      .from('campaigns')
      .select('smartlead_campaign_id')
      .eq('id', campaignId)
      .single();
    expect(camp.data?.smartlead_campaign_id).toBe(`sl-camp-${stamp}`);
    expect(addLeadCalls.at(-1)?.email).toBe(leadBEmail);
    expect(addLeadCalls.at(-1)?.custom_fields.velora_body?.length).toBeGreaterThan(0);

    const debits = await admin
      .from('credit_ledger')
      .select('delta')
      .eq('organization_id', a.orgId)
      .eq('reason', 'send');
    expect((debits.data ?? []).length).toBe(1);
    expect(Number(debits.data?.[0]?.delta)).toBe(-1);

    // Idempotent re-send → still one message, one debit, AND CRITICALLY no second Smartlead push
    // (C1: the claim-before-push gate). A retry must NEVER re-send a real email.
    const pushesBefore = addLeadCalls.length;
    const enr2 = (await admin.from('enrollments').select('*').eq('id', enrSuccess).single()).data;
    const res2 = await executeSend(userDb(a.token), enr2 as never, fake);
    expect(res2.outcome).toBe('duplicate');
    expect(addLeadCalls.length).toBe(pushesBefore); // NO second push
    const debits2 = await admin
      .from('credit_ledger')
      .select('id')
      .eq('organization_id', a.orgId)
      .eq('reason', 'send');
    expect((debits2.data ?? []).length).toBe(1);
    const msgs = await admin.from('messages').select('id').eq('enrollment_id', enrSuccess);
    expect((msgs.data ?? []).length).toBe(1);
  }, 90_000);

  it.skipIf(!env.SMARTLEAD_WEBHOOK_SECRET)(
    'EMAIL_SENT webhook via URL token (production path) → message sent + enrollment sent; no proof → 401',
    async () => {
      const app = Fastify();
      await app.register(webhooksRoute);
      const secret = env.SMARTLEAD_WEBHOOK_SECRET as string;
      const payload = JSON.stringify({
        event_type: 'EMAIL_SENT',
        campaign_id: `sl-camp-${stamp}`,
        to_email: leadBEmail,
        message_id: `m-${stamp}`,
      });
      const sig = `sha256=${createHmac('sha256', secret).update(payload, 'utf8').digest('hex')}`;

      // No valid proof → 401 (bad sig header alone no longer the only gate — still rejected).
      const bad = await app.inject({
        method: 'POST',
        url: '/webhooks/smartlead',
        headers: { 'content-type': 'application/json', 'x-smartlead-signature': 'sha256=nope' },
        payload,
      });
      expect(bad.statusCode).toBe(401);

      // URL token — the path a real Smartlead registration uses (?token= in the webhook URL).
      const ok = await app.inject({
        method: 'POST',
        url: `/webhooks/smartlead?token=${encodeURIComponent(secret)}`,
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(ok.statusCode).toBe(200);

      // Legacy HMAC header still accepted (idempotent replay of the same event).
      const okSig = await app.inject({
        method: 'POST',
        url: '/webhooks/smartlead',
        headers: { 'content-type': 'application/json', 'x-smartlead-signature': sig },
        payload,
      });
      expect(okSig.statusCode).toBe(200);
      await app.close();

      const msg = await admin
        .from('messages')
        .select('status, smartlead_message_id')
        .eq('enrollment_id', enrSuccess)
        .single();
      expect(msg.data?.status).toBe('sent');
      expect(msg.data?.smartlead_message_id).toBe(`m-${stamp}`);
      const enr = await admin.from('enrollments').select('status').eq('id', enrSuccess).single();
      expect(enr.data?.status).toBe('sent');
    },
    60_000,
  );
});
