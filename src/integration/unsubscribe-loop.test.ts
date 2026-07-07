import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeReplySend } from '../agents/reply/send.js';
import { executeSend } from '../agents/sending/pipeline.js';
import { unsubscribeRoute } from '../api/routes/unsubscribe.js';
import { env } from '../config/env.js';
import type { SmartleadClient } from '../integrations/smartlead/types.js';
import { signUnsubscribe } from '../lib/unsubscribe.js';

// L1 part 3 — the Velora-hosted unsubscribe LOOP, end to end (RUN_DB_IT). Proves: a bare GET never
// mutates (scanner-safe); a POST with a valid signed token writes suppression_list; the suppression
// then BLOCKS a subsequent send at BOTH chokepoints (cold executeSend + reply executeReplySend); and a
// tampered token is rejected (no suppression written). Fake Smartlead client — zero real email.
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SECRET = 'test-unsub-secret';

const fake: SmartleadClient = {
  async listEmailAccounts() {
    return [];
  },
  async getWarmupStats() {
    return {};
  },
  async createCampaign() {
    return { id: 'sl-none' };
  },
  async saveSequence() {},
  async assignEmailAccounts() {},
  async setSchedule() {},
  async setStatus() {},
  async addLead() {
    throw new Error('addLead must never be called — the send should be suppressed');
  },
  async sendReply() {
    throw new Error('sendReply must never be called — the reply should be suppressed');
  },
};

describe.skipIf(!ready)('L1 — Velora-hosted unsubscribe loop (zero real email)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const email = `unsub+${stamp}@x.com`;
  let orgId = '';
  let campaignId = '';
  let personId = '';
  let coldEnrId = '';
  let replyTaskId = '';
  const app = Fastify();

  const countSuppressions = async () =>
    (
      (
        await admin
          .from('suppression_list')
          .select('id, reason')
          .eq('organization_id', orgId)
          .eq('email', email)
      ).data ?? []
    ).length;

  beforeAll(async () => {
    await app.register(unsubscribeRoute, { secret: SECRET });

    orgId = (
      await admin
        .from('organizations')
        .insert({ name: `unsub-${stamp}` })
        .select('id')
        .single()
    ).data?.id as string;
    personId = (
      await admin
        .from('people')
        .insert({
          organization_id: orgId,
          provider: 'seed',
          external_id: `unsub:${stamp}`,
          full_name: 'Lead',
          email,
          title: 'CTO',
          company_name: 'Co',
          source: 'find_leads',
        })
        .select('id')
        .single()
    ).data?.id as string;
    campaignId = (
      await admin
        .from('campaigns')
        .insert({
          organization_id: orgId,
          name: 'Unsub',
          campaign_type: 'cold_outbound',
          status: 'active',
        })
        .select('id')
        .single()
    ).data?.id as string;

    // Cold: an enrollment with an APPROVED outbound task + a frozen verified_email → executeSend
    // reaches the (pre-live) suppression re-check on that address.
    const coldTask = (
      await admin
        .from('tasks')
        .insert({
          organization_id: orgId,
          type: 'outbound_approval',
          status: 'approved',
          lead_type: 'person',
          lead_id: personId,
          campaign_id: campaignId,
          subject: 'Hi',
          body: 'Hi there — quick question.',
        })
        .select('id')
        .single()
    ).data?.id as string;
    coldEnrId = (
      await admin
        .from('enrollments')
        .insert({
          organization_id: orgId,
          campaign_id: campaignId,
          lead_type: 'person',
          lead_id: personId,
          status: 'awaiting_approval',
          task_id: coldTask,
          verified_email: email,
        })
        .select('id')
        .single()
    ).data?.id as string;

    // Reply: a thread + an APPROVED reply_approval task → executeReplySend looks up this enrollment by
    // (org, campaign, lead) and re-checks suppression on its verified_email.
    const threadId = (
      await admin
        .from('threads')
        .insert({
          organization_id: orgId,
          campaign_id: campaignId,
          lead_type: 'person',
          lead_id: personId,
          subject: 'Re: Hi',
          status: 'active',
        })
        .select('id')
        .single()
    ).data?.id as string;
    replyTaskId = (
      await admin
        .from('tasks')
        .insert({
          organization_id: orgId,
          type: 'reply_approval',
          status: 'approved',
          lead_type: 'person',
          lead_id: personId,
          campaign_id: campaignId,
          thread_id: threadId,
          subject: 'Re: Hi',
          body: 'Thanks for the reply.',
        })
        .select('id')
        .single()
    ).data?.id as string;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
  });

  const urlFor = (token: string) => `/u?t=${encodeURIComponent(token)}`;

  it('GET /u renders a confirmation page and does NOT mutate (scanner-safe)', async () => {
    const token = signUnsubscribe(orgId, email, SECRET);
    const res = await app.inject({ method: 'GET', url: urlFor(token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Confirm unsubscribe');
    expect(await countSuppressions()).toBe(0); // a GET must never write a suppression row
  });

  it('POST /u verifies the token and writes a suppression (reason unsubscribe); idempotent', async () => {
    const token = signUnsubscribe(orgId, email, SECRET);
    const res = await app.inject({ method: 'POST', url: urlFor(token) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('unsubscribed');
    expect(await countSuppressions()).toBe(1);
    const row = (
      await admin
        .from('suppression_list')
        .select('reason, source')
        .eq('organization_id', orgId)
        .eq('email', email)
        .single()
    ).data;
    expect(row?.reason).toBe('unsubscribe');

    // Re-submit → idempotent, still exactly one row.
    const again = await app.inject({ method: 'POST', url: urlFor(token) });
    expect(again.statusCode).toBe(200);
    expect(await countSuppressions()).toBe(1);
  });

  it('the suppression BLOCKS a subsequent COLD send (executeSend → suppressed, no push)', async () => {
    const enr = (await admin.from('enrollments').select('*').eq('id', coldEnrId).single()).data;
    const res = await executeSend(admin, enr as never, fake);
    expect(res.outcome).toBe('suppressed');
  }, 60_000);

  it('the suppression BLOCKS a subsequent REPLY send (executeReplySend → suppressed, no push)', async () => {
    const res = await executeReplySend(admin, replyTaskId, fake);
    expect(res.outcome).toBe('suppressed');
  }, 60_000);

  it('a TAMPERED token is rejected — no suppression written, 400', async () => {
    const other = `attacker+${stamp}@x.com`;
    const good = signUnsubscribe(orgId, other, SECRET);
    const [body] = good.split('~');
    const tampered = `${body}~deadbeefsig`;
    const res = await app.inject({ method: 'POST', url: `/u?t=${encodeURIComponent(tampered)}` });
    expect(res.statusCode).toBe(400);
    const forged = (
      await admin
        .from('suppression_list')
        .select('id')
        .eq('organization_id', orgId)
        .eq('email', other)
    ).data;
    expect((forged ?? []).length).toBe(0); // nothing suppressed via a bad signature
  });
});
