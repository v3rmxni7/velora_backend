import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReplyCategory } from '../agents/reply/classify.js';
import { runReplyDraft } from '../agents/reply/draft.js';
import { applySmartleadEvent, type ReplyDraftRequest } from '../agents/sending/inbound.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB, STUBBED reply-writer (no LLM), service-role. Proves Slice 3.3b:
// an 'engage' reply enqueues a draft, and runReplyDraft files a grounded reply_approval task for
// HUMAN review (never sent). NO real email, NO LLM.
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)(
  'Slice 3.3b — grounded reply draft (reply_approval task, human-reviewed)',
  () => {
    const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const stamp = Date.now();
    const slCampaignId = `sl-camp-33b-${stamp}`;
    let orgId = '';
    let campaignId = '';
    let seq = 0;

    // Claim-free stub (verifies trivially) → a reply_approval task without needing real proof ids.
    const stubDraft = {
      draft: async () => ({
        subject: 'Re: Hi',
        body: 'Thanks for getting back to me — would you be open to a quick call next week?',
        usedFactIds: [] as string[],
      }),
    };

    async function setReplyMode(autonomyEnabled: boolean, autoReply: 'off' | 'draft' | 'send') {
      const r = await admin
        .from('organizations')
        .update({ autonomy_enabled: autonomyEnabled, auto_reply_mode: autoReply })
        .eq('id', orgId);
      if (r.error) throw r.error;
    }
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
          subject: 'Quick idea',
          status: 'active',
          last_message_at: new Date().toISOString(),
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
      // The prior outbound (our cold email) — conversation context for the reply.
      await admin.from('messages').insert({
        organization_id: orgId,
        thread_id: threadId,
        enrollment_id: e.data.id as string,
        direction: 'outbound',
        channel: 'email',
        subject: 'Quick idea',
        body: 'We help teams onboard faster.',
        status: 'sent',
        dedupe_key: `send:${orgId}:${e.data.id}:1`,
      });
      return { enrId: e.data.id as string, threadId, email };
    }
    async function reply(
      email: string,
      category: ReplyCategory,
      body: string,
      msgId: string,
      deps: { enqueueReplyDraft?: (i: ReplyDraftRequest) => Promise<void> } = {},
    ) {
      return applySmartleadEvent(
        admin,
        {
          event_type: 'EMAIL_REPLY',
          campaign_id: slCampaignId,
          to_email: email,
          message_id: msgId,
          reply_body: body,
        },
        { classify: async () => category, ...deps },
      );
    }
    async function replyTasks(threadId: string) {
      const r = await admin
        .from('tasks')
        .select('status, body, draft_mode, grounding, thread_id')
        .eq('organization_id', orgId)
        .eq('thread_id', threadId)
        .eq('type', 'reply_approval');
      if (r.error) throw r.error;
      return r.data ?? [];
    }

    beforeAll(async () => {
      const o = await admin
        .from('organizations')
        .insert({ name: `s33b-${stamp}` })
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
      await admin.from('proof_items').insert({
        organization_id: orgId,
        category: 'highlight',
        title: 'Onboarding',
        body: 'cut onboarding time 40%',
      });
      await admin
        .from('coaching_points')
        .insert({ organization_id: orgId, content: 'Be concise.' });
    }, 180_000);

    afterAll(async () => {
      if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    });

    it('runReplyDraft files a grounded reply_approval task (pending, thread-linked); idempotent', async () => {
      await setReplyMode(true, 'draft');
      const { enrId, threadId, email } = await seedSent();
      const msgId = `m:${seq}:${stamp}`;
      await reply(email, 'interested', 'tell me more', msgId); // creates the inbound message

      const res = await runReplyDraft(
        {
          db: admin,
          organizationId: orgId,
          enrollmentId: enrId,
          threadId,
          inboundMessageId: msgId,
          category: 'interested',
        },
        stubDraft,
      );
      expect(res.task).not.toBeNull();

      const tasks = await replyTasks(threadId);
      expect(tasks.length).toBe(1);
      expect(tasks[0]?.status).toBe('pending');
      expect((tasks[0]?.body as string | null)?.length).toBeGreaterThan(0);
      expect((tasks[0]?.grounding as { verification?: { ok?: boolean } })?.verification?.ok).toBe(
        true,
      );

      // Idempotent: re-running files no second task (stable dedupe key).
      await runReplyDraft(
        {
          db: admin,
          organizationId: orgId,
          enrollmentId: enrId,
          threadId,
          inboundMessageId: msgId,
          category: 'interested',
        },
        stubDraft,
      );
      expect((await replyTasks(threadId)).length).toBe(1);
    }, 90_000);

    it('inbound ENQUEUES a draft only on engage (interested), not on suppress/snooze/escalate/off', async () => {
      const calls: ReplyDraftRequest[] = [];
      const spy = async (i: ReplyDraftRequest) => {
        calls.push(i);
      };

      // engage (relaxed + interested) → enqueues
      await setReplyMode(true, 'draft');
      const a = await seedSent();
      await reply(a.email, 'interested', 'tell me more', `e:${seq}:${stamp}`, {
        enqueueReplyDraft: spy,
      });
      expect(calls.length).toBe(1);
      expect(calls[0]?.enrollmentId).toBe(a.enrId);
      expect(calls[0]?.category).toBe('interested');

      // not_interested (suppress) → no enqueue
      const b = await seedSent();
      await reply(b.email, 'not_interested', 'not for us', `n:${seq}:${stamp}`, {
        enqueueReplyDraft: spy,
      });
      // out_of_office (snooze) → no enqueue
      const c = await seedSent();
      await reply(c.email, 'out_of_office', 'on leave', `o:${seq}:${stamp}`, {
        enqueueReplyDraft: spy,
      });
      // other (escalate) → no enqueue
      const d = await seedSent();
      await reply(d.email, 'other', 'who is this?', `x:${seq}:${stamp}`, {
        enqueueReplyDraft: spy,
      });
      expect(calls.length).toBe(1); // still just the engage one

      // off-mode interested → no enqueue
      await setReplyMode(false, 'off');
      const f = await seedSent();
      await reply(f.email, 'interested', 'tell me more', `f:${seq}:${stamp}`, {
        enqueueReplyDraft: spy,
      });
      expect(calls.length).toBe(1);
    }, 120_000);
  },
);
