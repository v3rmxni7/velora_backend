import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autoSendReplyIfQualified, executeReplySend } from '../agents/reply/send.js';
import { env } from '../config/env.js';
import type { SmartleadClient } from '../integrations/smartlead/types.js';

// Opt-in (RUN_DB_IT=1). Live DB, FAKE Smartlead, flags flipped FOR THE TEST ORG ONLY. Proves Slice
// 3.4 (the riskiest): an autonomous reply SEND rides a gated chokepoint, DRY-RUN by construction
// (the fake sendReply is NEVER called in any dry-run path → ZERO real email), heavily gated, and
// idempotent. The demo org is never touched.
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

interface SeedTask {
  draftMode: 'personalized' | 'template';
  confidence: number;
  verified: boolean;
  approved?: boolean;
}

describe.skipIf(!ready)(
  'Slice 3.4 — autonomous reply send (gated chokepoint, dry-run, zero real email)',
  () => {
    const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const stamp = Date.now();
    const slCampaignId = `sl-camp-34-${stamp}`;
    let orgId = '';
    let campaignId = '';
    let seq = 0;

    const replyCalls: { email: string }[] = [];
    const fake: SmartleadClient = {
      async listEmailAccounts() {
        return [];
      },
      async getWarmupStats() {
        return {};
      },
      async createCampaign() {
        return { id: slCampaignId };
      },
      async saveSequence() {},
      async assignEmailAccounts() {},
      async setSchedule() {},
      async setStatus() {},
      async addLead() {},
      async sendReply(_c, reply) {
        replyCalls.push({ email: reply.email });
      },
    };

    async function setMode(autonomyEnabled: boolean, autoReply: 'off' | 'draft' | 'send') {
      const r = await admin
        .from('organizations')
        .update({
          autonomy_enabled: autonomyEnabled,
          auto_reply_mode: autoReply,
          auto_send_min_confidence: 0.8,
        })
        .eq('id', orgId);
      if (r.error) throw r.error;
    }
    async function setSending(sendingEnabled: boolean, dryRun: boolean) {
      const r = await admin
        .from('organizations')
        .update({ sending_enabled: sendingEnabled, sending_dry_run: dryRun })
        .eq('id', orgId);
      if (r.error) throw r.error;
    }
    // Seed a thread + sent enrollment + a reply_approval task (controlled draft fields), deterministic.
    async function seedReplyTask(
      t: SeedTask,
    ): Promise<{ taskId: string; threadId: string; email: string }> {
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
          subject: 'Quick idea',
          status: 'needs_action',
        })
        .select('id')
        .single();
      if (thread.error) throw thread.error;
      const threadId = thread.data.id as string;
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
          thread_id: threadId,
        })
        .select('id')
        .single();
      if (e.error) throw e.error;
      // The inbound reply (so a live path has a thread ref) — not used in dry-run.
      await admin.from('messages').insert({
        organization_id: orgId,
        thread_id: threadId,
        enrollment_id: e.data.id as string,
        direction: 'inbound',
        channel: 'email',
        body: 'tell me more',
        status: 'replied',
        smartlead_message_id: `in:${seq}:${stamp}`,
        dedupe_key: `reply:${orgId}:${e.data.id}:in${seq}`,
      });
      const task = await admin
        .from('tasks')
        .insert({
          organization_id: orgId,
          type: 'reply_approval',
          status: t.approved ? 'approved' : 'pending',
          lead_type: 'person',
          lead_id: p.data.id as string,
          campaign_id: campaignId,
          thread_id: threadId,
          subject: 'Re: Quick idea',
          body: 'Thanks — happy to share more. Open to a quick call next week?',
          draft_mode: t.draftMode,
          confidence: t.confidence,
          grounding: {
            mode: t.draftMode,
            verification: { ok: t.verified, unverified: [], regenerated: false },
          },
          dedupe_key: `reply_draft:${orgId}:${e.data.id}:in${seq}`,
        })
        .select('id')
        .single();
      if (task.error) throw task.error;
      return { taskId: task.data.id as string, threadId, email };
    }
    async function replyMessages(threadId: string) {
      const r = await admin
        .from('messages')
        .select('status, dedupe_key')
        .eq('organization_id', orgId)
        .eq('thread_id', threadId)
        .like('dedupe_key', 'reply_send:%');
      if (r.error) throw r.error;
      return r.data ?? [];
    }
    async function replyDebits(taskId: string) {
      const r = await admin
        .from('credit_ledger')
        .select('delta, reason')
        .eq('organization_id', orgId)
        .eq('idempotency_key', `reply_send:${orgId}:${taskId}`);
      if (r.error) throw r.error;
      return r.data ?? [];
    }
    async function autoSendAudits(taskId: string) {
      const r = await admin
        .from('autonomy_events')
        .select('decision')
        .eq('task_id', taskId)
        .eq('kind', 'reply')
        .eq('decision', 'auto_send');
      if (r.error) throw r.error;
      return r.data ?? [];
    }
    async function taskStatus(taskId: string) {
      return (await admin.from('tasks').select('status').eq('id', taskId).single()).data?.status;
    }

    beforeAll(async () => {
      const o = await admin
        .from('organizations')
        .insert({ name: `s34-${stamp}` })
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

    it('AUTO-SEND (dry-run): personalized+verified+≥floor, send-mode → approved + dry_run reply + audit, ZERO push', async () => {
      await setMode(true, 'send');
      await setSending(false, true);
      const { taskId, threadId } = await seedReplyTask({
        draftMode: 'personalized',
        confidence: 0.95,
        verified: true,
      });
      const before = replyCalls.length;

      const r = await autoSendReplyIfQualified(admin, taskId, fake);
      expect(r?.decision).toBe('auto_send');
      expect(r?.outcome).toBe('dry_run');
      expect(await taskStatus(taskId)).toBe('approved');
      const msgs = await replyMessages(threadId);
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.status).toBe('dry_run');
      expect((await autoSendAudits(taskId)).length).toBe(1);
      expect(replyCalls.length).toBe(before); // sendReply NEVER called
    }, 90_000);

    it('template draft → escalate: stays pending, no reply, no auto_send audit', async () => {
      await setMode(true, 'send');
      const { taskId, threadId } = await seedReplyTask({
        draftMode: 'template',
        confidence: 0.99,
        verified: true,
      });
      const r = await autoSendReplyIfQualified(admin, taskId, fake);
      expect(r?.decision).toBe('escalate');
      expect(r?.reason).toBe('not_personalized');
      expect(await taskStatus(taskId)).toBe('pending');
      expect((await replyMessages(threadId)).length).toBe(0);
      expect((await autoSendAudits(taskId)).length).toBe(0);
    }, 60_000);

    it("auto_reply_mode='draft' (not send) → escalate, no auto-send", async () => {
      await setMode(true, 'draft');
      const { taskId } = await seedReplyTask({
        draftMode: 'personalized',
        confidence: 0.95,
        verified: true,
      });
      const r = await autoSendReplyIfQualified(admin, taskId, fake);
      expect(r?.reason).toBe('auto_reply_not_send');
      expect(await taskStatus(taskId)).toBe('pending');
    }, 60_000);

    it('KILL SWITCH: autonomy off → escalate, no send', async () => {
      await setMode(false, 'send');
      const { taskId, threadId } = await seedReplyTask({
        draftMode: 'personalized',
        confidence: 0.95,
        verified: true,
      });
      const r = await autoSendReplyIfQualified(admin, taskId, fake);
      expect(r?.reason).toBe('autonomy_disabled');
      expect((await replyMessages(threadId)).length).toBe(0);
    }, 60_000);

    it('THE two-flag proof: auto-send with sending half-flipped (enabled, dry_run on) → dry_run only, ZERO push', async () => {
      await setMode(true, 'send');
      await setSending(true, true); // both needed for live; dry_run still on → safe
      const { taskId, threadId } = await seedReplyTask({
        draftMode: 'personalized',
        confidence: 0.95,
        verified: true,
      });
      const before = replyCalls.length;
      const r = await autoSendReplyIfQualified(admin, taskId, fake);
      expect(r?.outcome).toBe('dry_run');
      expect((await replyMessages(threadId))[0]?.status).toBe('dry_run');
      expect(replyCalls.length).toBe(before);
      await setSending(false, true);
    }, 90_000);

    it('suppression re-check: a suppressed recipient → suppressed, no reply message', async () => {
      await setMode(true, 'send');
      const { taskId, threadId, email } = await seedReplyTask({
        draftMode: 'personalized',
        confidence: 0.95,
        verified: true,
        approved: true,
      });
      await admin
        .from('suppression_list')
        .insert({ organization_id: orgId, email, reason: 'unsubscribe', source: 'manual' });
      const res = await executeReplySend(admin, taskId, fake);
      expect(res.outcome).toBe('suppressed');
      expect((await replyMessages(threadId)).length).toBe(0);
    }, 60_000);

    it('human-approved reply (approved task) → executeReplySend writes a dry_run reply; idempotent', async () => {
      await setMode(true, 'send');
      await setSending(false, true);
      const { taskId, threadId } = await seedReplyTask({
        draftMode: 'personalized',
        confidence: 0.95,
        verified: true,
        approved: true,
      });
      const r1 = await executeReplySend(admin, taskId, fake);
      expect(r1.outcome).toBe('dry_run');
      // Idempotent: a second call writes no second reply message (claim-before-push on reply_send key).
      await executeReplySend(admin, taskId, fake);
      expect((await replyMessages(threadId)).length).toBe(1);
    }, 90_000);

    it('4.1c — LIVE reply-send debits exactly one reply credit (idempotent); dry-run debits none', async () => {
      await setMode(true, 'send');

      // Dry-run debits nothing.
      await setSending(false, true);
      const dry = await seedReplyTask({
        draftMode: 'personalized',
        confidence: 0.95,
        verified: true,
        approved: true,
      });
      await executeReplySend(admin, dry.taskId, fake);
      expect((await replyDebits(dry.taskId)).length).toBe(0);

      // LIVE (flags flipped FOR THE TEST ORG ONLY; fake client → ZERO real email).
      await setSending(true, false);
      const live = await seedReplyTask({
        draftMode: 'personalized',
        confidence: 0.95,
        verified: true,
        approved: true,
      });
      const before = replyCalls.length;
      const r1 = await executeReplySend(admin, live.taskId, fake);
      expect(r1.outcome).toBe('queued');
      expect(replyCalls.length).toBe(before + 1); // the (fake) push happened — no real email
      const debits = await replyDebits(live.taskId);
      expect(debits.length).toBe(1);
      expect(debits[0]?.reason).toBe('reply');
      expect(Number(debits[0]?.delta)).toBe(-1);

      // Idempotent: a retry returns duplicate (C1 pre-check) → no second debit.
      const r2 = await executeReplySend(admin, live.taskId, fake);
      expect(r2.outcome).toBe('duplicate');
      expect((await replyDebits(live.taskId)).length).toBe(1);

      await setSending(false, true);
    }, 90_000);
  },
);
