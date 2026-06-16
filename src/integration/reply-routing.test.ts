import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReplyCategory } from '../agents/reply/classify.js';
import { applySmartleadEvent } from '../agents/sending/inbound.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB, SIMULATED webhooks, service-role, FAKE classifier. Proves Slice
// 3.3: the reply decision now ROUTES (conditional suppress + thread status). Off-mode stays exactly
// Phase-2; relaxed mode suppresses only genuine stop signals. NO real email, NO LLM.
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('Slice 3.3 — reply routing (conditional suppress + thread status)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const slCampaignId = `sl-camp-33-${stamp}`;
  let orgId = '';
  let campaignId = '';
  let seq = 0;

  async function setReplyMode(autonomyEnabled: boolean, autoReply: 'off' | 'draft' | 'send') {
    const r = await admin
      .from('organizations')
      .update({ autonomy_enabled: autonomyEnabled, auto_reply_mode: autoReply })
      .eq('id', orgId);
    if (r.error) throw r.error;
  }
  // Seed a "sent" enrollment + thread (a reply target), mirroring inbound-events.test.ts.
  async function seedSent(): Promise<{ enrId: string; threadId: string; email: string }> {
    seq += 1;
    const email = `r${seq}+${stamp}@x.com`;
    const p = await admin
      .from('people')
      .insert({
        organization_id: orgId,
        provider: 'seed',
        external_id: `r:${seq}:${stamp}`,
        full_name: 'Lead',
        email,
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (p.error) throw p.error;
    const thread = await admin
      .from('threads')
      .insert({
        organization_id: orgId,
        campaign_id: campaignId,
        lead_type: 'person',
        lead_id: p.data.id as string,
        subject: 'Hi',
        status: 'active',
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (thread.error) throw thread.error;
    const e = await admin
      .from('enrollments')
      .insert({
        organization_id: orgId,
        campaign_id: campaignId,
        lead_type: 'person',
        lead_id: p.data.id as string,
        status: 'sent',
        current_step: 1,
        verified_email: email,
        thread_id: thread.data.id as string,
      })
      .select('id')
      .single();
    if (e.error) throw e.error;
    return { enrId: e.data.id as string, threadId: thread.data.id as string, email };
  }
  async function reply(email: string, category: ReplyCategory, body: string) {
    return applySmartleadEvent(
      admin,
      {
        event_type: 'EMAIL_REPLY',
        campaign_id: slCampaignId,
        to_email: email,
        message_id: `m:${seq}:${stamp}`,
        reply_body: body,
      },
      { classify: async () => category },
    );
  }
  async function isSuppressed(email: string): Promise<boolean> {
    const r = await admin
      .from('suppression_list')
      .select('reason')
      .eq('organization_id', orgId)
      .eq('email', email);
    if (r.error) throw r.error;
    return (r.data ?? []).length > 0;
  }
  async function threadStatus(threadId: string) {
    return (await admin.from('threads').select('status').eq('id', threadId).single()).data?.status;
  }
  async function replyAudit(enrId: string) {
    const r = await admin
      .from('autonomy_events')
      .select('decision')
      .eq('enrollment_id', enrId)
      .eq('kind', 'reply');
    if (r.error) throw r.error;
    return r.data ?? [];
  }

  beforeAll(async () => {
    const o = await admin
      .from('organizations')
      .insert({ name: `s33-${stamp}` })
      .select('id')
      .single();
    if (o.error) throw o.error;
    orgId = o.data.id as string;
    const c = await admin
      .from('campaigns')
      .insert({
        organization_id: orgId,
        name: 'Reply',
        campaign_type: 'cold_outbound',
        status: 'active',
        smartlead_campaign_id: slCampaignId,
      })
      .select('id')
      .single();
    if (c.error) throw c.error;
    campaignId = c.data.id as string;
  }, 180_000);

  afterAll(async () => {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
  });

  it('OFF-mode = exactly Phase-2: an interested reply → suppressed + needs_action + replied, no audit', async () => {
    await setReplyMode(false, 'off');
    const { enrId, threadId, email } = await seedSent();
    expect((await reply(email, 'interested', 'tell me more')).handled).toBe(true);
    expect(await isSuppressed(email)).toBe(true);
    expect(await threadStatus(threadId)).toBe('needs_action');
    const enr = await admin.from('enrollments').select('status').eq('id', enrId).single();
    expect(enr.data?.status).toBe('replied');
    expect((await replyAudit(enrId)).length).toBe(0); // autonomy off → no audit
  }, 60_000);

  it('autonomy on but auto_reply_mode=off → still Phase-2 (suppress + needs_action) + shadow audit', async () => {
    await setReplyMode(true, 'off');
    const { enrId, threadId, email } = await seedSent();
    await reply(email, 'interested', 'tell me more');
    expect(await isSuppressed(email)).toBe(true);
    expect(await threadStatus(threadId)).toBe('needs_action');
    expect((await replyAudit(enrId))[0]?.decision).toBe('suppress');
  }, 60_000);

  describe('relaxed (auto_reply_mode=draft)', () => {
    it('interested → NOT suppressed + needs_action (engage; human replies in 3.3, draft in 3.3b)', async () => {
      await setReplyMode(true, 'draft');
      const { enrId, threadId, email } = await seedSent();
      await reply(email, 'interested', 'tell me more');
      expect(await isSuppressed(email)).toBe(false);
      expect(await threadStatus(threadId)).toBe('needs_action');
      expect(
        (await admin.from('enrollments').select('status').eq('id', enrId).single()).data?.status,
      ).toBe('replied');
      expect((await replyAudit(enrId))[0]?.decision).toBe('engage');
    }, 60_000);

    it('not_interested → suppressed + auto_handled (suppress)', async () => {
      await setReplyMode(true, 'draft');
      const { enrId, threadId, email } = await seedSent();
      await reply(email, 'not_interested', 'not for us right now');
      expect(await isSuppressed(email)).toBe(true);
      expect(await threadStatus(threadId)).toBe('auto_handled');
      expect((await replyAudit(enrId))[0]?.decision).toBe('suppress');
    }, 60_000);

    it('out_of_office → NOT suppressed + auto_handled (snooze)', async () => {
      await setReplyMode(true, 'draft');
      const { enrId, threadId, email } = await seedSent();
      await reply(email, 'out_of_office', 'I am on leave until next month');
      expect(await isSuppressed(email)).toBe(false);
      expect(await threadStatus(threadId)).toBe('auto_handled');
      expect((await replyAudit(enrId))[0]?.decision).toBe('snooze');
    }, 60_000);

    it('other → NOT suppressed + needs_action (escalate)', async () => {
      await setReplyMode(true, 'draft');
      const { enrId, threadId, email } = await seedSent();
      await reply(email, 'other', 'who is this?');
      expect(await isSuppressed(email)).toBe(false);
      expect(await threadStatus(threadId)).toBe('needs_action');
      expect((await replyAudit(enrId))[0]?.decision).toBe('escalate');
    }, 60_000);

    it('BACKSTOP: an explicit-stop body overrides a wrong "interested" classification → suppressed + auto_handled', async () => {
      await setReplyMode(true, 'send'); // most permissive — yet the stop backstop must still win
      const { threadId, email } = await seedSent();
      await reply(email, 'interested', 'actually, please unsubscribe me');
      expect(await isSuppressed(email)).toBe(true);
      expect(await threadStatus(threadId)).toBe('auto_handled');
    }, 60_000);
  });

  it('IDEMPOTENT: replaying the same reply adds no second suppression row / effect', async () => {
    await setReplyMode(true, 'draft');
    const { email } = await seedSent();
    await reply(email, 'not_interested', 'not for us'); // suppresses
    await reply(email, 'not_interested', 'not for us'); // replay → M5 dedupe → no-op
    const rows = await admin
      .from('suppression_list')
      .select('id')
      .eq('organization_id', orgId)
      .eq('email', email);
    expect((rows.data ?? []).length).toBe(1);
  }, 60_000);
});
