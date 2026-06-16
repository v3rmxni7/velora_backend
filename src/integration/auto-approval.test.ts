import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAutoApproval } from '../agents/sending/auto-approve.js';
import { applySmartleadEvent } from '../agents/sending/inbound.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';
import type { SmartleadClient } from '../integrations/smartlead/types.js';

// Opt-in (RUN_DB_IT=1). Live DB, FAKE Smartlead client, flags flipped FOR THE TEST ORG ONLY.
// Proves Slice 3.1: autonomous auto-approval drives the EXISTING executeSend chokepoint, dry-run by
// construction (ZERO real email), every decision audited; reply decisions are recorded in SHADOW
// (behavior unchanged). The demo org is never touched.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

type GroundingOk = boolean;
interface SeededTask {
  draftMode: 'personalized' | 'template';
  confidence: number;
  groundingOk: GroundingOk;
}

describe.skipIf(!ready)(
  'Slice 3.1 — autonomous auto-approval (dry-run, zero real email) + reply shadow',
  () => {
    const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anon = createClient(SUPABASE_URL, ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const stamp = Date.now();
    const slCampaignId = `sl-camp-31-${stamp}`;

    let orgA = '';
    let campaignA = '';
    // org B + a real signed-in user, for the RLS tenant-isolation check.
    let orgB = '';
    let userB = '';
    let tokenB = '';

    const addLeadCalls: { email: string }[] = [];
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
      async addLead(_c, lead) {
        addLeadCalls.push({ email: lead.email });
      },
      async sendReply() {},
    };

    async function setAutonomy(
      org: string,
      enabled: boolean,
      autoReply: 'off' | 'draft' | 'send' = 'off',
    ) {
      const r = await admin
        .from('organizations')
        .update({
          autonomy_enabled: enabled,
          auto_reply_mode: autoReply,
          auto_send_min_confidence: 0.8,
        })
        .eq('id', org);
      if (r.error) throw r.error;
    }
    async function setSending(org: string, sendingEnabled: boolean, dryRun: boolean) {
      const r = await admin
        .from('organizations')
        .update({ sending_enabled: sendingEnabled, sending_dry_run: dryRun })
        .eq('id', org);
      if (r.error) throw r.error;
    }
    async function person(org: string, ext: string, email: string): Promise<string> {
      const p = await admin
        .from('people')
        .insert({
          organization_id: org,
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
    // Seed an awaiting_approval enrollment with a directly-controlled draft task (deterministic, no LLM).
    async function seedAwaiting(email: string, ext: string, t: SeededTask): Promise<string> {
      const leadId = await person(orgA, ext, email);
      const task = await admin
        .from('tasks')
        .insert({
          organization_id: orgA,
          type: 'outbound_approval',
          status: 'pending',
          lead_type: 'person',
          lead_id: leadId,
          campaign_id: campaignA,
          subject: 'Hi there',
          body: 'A grounded, personalized opening line.',
          draft_mode: t.draftMode,
          confidence: t.confidence,
          grounding: {
            mode: t.draftMode,
            overallConfidence: t.confidence,
            facts: [],
            usedFactIds: [],
            verification: { ok: t.groundingOk, unverified: [], regenerated: false },
          },
          dedupe_key: `draft:${orgA}:person:${leadId}:${campaignA}`,
        })
        .select('id')
        .single();
      if (task.error) throw task.error;
      const e = await admin
        .from('enrollments')
        .insert({
          organization_id: orgA,
          campaign_id: campaignA,
          lead_type: 'person',
          lead_id: leadId,
          status: 'awaiting_approval',
          current_step: 1,
          task_id: task.data.id as string,
          verified_email: email,
          verification: 'deliverable',
        })
        .select('id')
        .single();
      if (e.error) throw e.error;
      return e.data.id as string;
    }
    // Seed a "sent" enrollment (for the reply path), mirroring inbound-events.test.ts.
    async function seedSent(email: string, ext: string): Promise<string> {
      const leadId = await person(orgA, ext, email);
      const thread = await admin
        .from('threads')
        .insert({
          organization_id: orgA,
          campaign_id: campaignA,
          lead_type: 'person',
          lead_id: leadId,
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
          organization_id: orgA,
          campaign_id: campaignA,
          lead_type: 'person',
          lead_id: leadId,
          status: 'sent',
          current_step: 1,
          verified_email: email,
          thread_id: thread.data.id as string,
        })
        .select('id')
        .single();
      if (e.error) throw e.error;
      await admin.from('messages').insert({
        organization_id: orgA,
        thread_id: thread.data.id as string,
        enrollment_id: e.data.id as string,
        direction: 'outbound',
        channel: 'email',
        subject: 'Hi',
        body: 'Hello there',
        status: 'sent',
        dedupe_key: `send:${orgA}:${e.data.id}:1`,
      });
      return e.data.id as string;
    }
    async function auditRows(enrollmentId: string) {
      const r = await admin
        .from('autonomy_events')
        .select('kind, decision, reason, confidence')
        .eq('enrollment_id', enrollmentId);
      if (r.error) throw r.error;
      return r.data ?? [];
    }

    beforeAll(async () => {
      const oa = await admin
        .from('organizations')
        .insert({ name: `s31a-${stamp}` })
        .select('id')
        .single();
      if (oa.error) throw oa.error;
      orgA = oa.data.id as string;
      const camp = await admin
        .from('campaigns')
        .insert({
          organization_id: orgA,
          name: 'Auto',
          campaign_type: 'cold_outbound',
          status: 'active',
          smartlead_campaign_id: slCampaignId,
        })
        .select('id')
        .single();
      if (camp.error) throw camp.error;
      campaignA = camp.data.id as string;
      await admin.from('coaching_points').insert({ organization_id: orgA, content: 'concise' });

      // org B + a signed-in user for the isolation test.
      const ob = await admin
        .from('organizations')
        .insert({ name: `s31b-${stamp}` })
        .select('id')
        .single();
      if (ob.error) throw ob.error;
      orgB = ob.data.id as string;
      const emailB = `s31b+${stamp}@example.com`;
      const pwd = `Test-${stamp}-pw!`;
      const created = await admin.auth.admin.createUser({
        email: emailB,
        password: pwd,
        email_confirm: true,
      });
      if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
      userB = created.data.user.id;
      await admin
        .from('users')
        .insert({ id: userB, organization_id: orgB, email: emailB, role: 'owner' });
      const signin = await anon.auth.signInWithPassword({ email: emailB, password: pwd });
      if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
      tokenB = signin.data.session.access_token;
    }, 180_000);

    afterAll(async () => {
      if (orgA) await admin.from('organizations').delete().eq('id', orgA);
      if (orgB) await admin.from('organizations').delete().eq('id', orgB);
      if (userB) await admin.auth.admin.deleteUser(userB);
    });

    it('autonomy_on + personalized + verified + ≥floor → auto-approved + dry-run send, audit auto_send, ZERO push', async () => {
      await setAutonomy(orgA, true);
      await setSending(orgA, false, true); // safe default — dry-run
      const enrId = await seedAwaiting(`ok+${stamp}@x.com`, `ok:${stamp}`, {
        draftMode: 'personalized',
        confidence: 0.9,
        groundingOk: true,
      });
      const pushesBefore = addLeadCalls.length;
      const res = await runAutoApproval(admin, enrId, fake);
      expect(res?.decision).toBe('auto_send');
      expect(res?.sendOutcome).toBe('dry_run');

      const task = await admin
        .from('tasks')
        .select('status')
        .eq(
          'id',
          (await admin.from('enrollments').select('task_id').eq('id', enrId).single()).data
            ?.task_id,
        )
        .single();
      expect(task.data?.status).toBe('approved');

      const msg = await admin.from('messages').select('status').eq('enrollment_id', enrId).single();
      expect(msg.data?.status).toBe('dry_run');
      const enr = await admin.from('enrollments').select('status').eq('id', enrId).single();
      expect(enr.data?.status).toBe('sent');

      const audit = await auditRows(enrId);
      expect(audit.length).toBe(1);
      expect(audit[0]?.kind).toBe('cold_send');
      expect(audit[0]?.decision).toBe('auto_send');
      expect(Number(audit[0]?.confidence)).toBeCloseTo(0.9, 3);

      expect(addLeadCalls.length).toBe(pushesBefore); // NOTHING pushed — zero real email
    }, 90_000);

    it('template draft → escalate (stays in human queue, NO send, audit escalate/not_personalized)', async () => {
      await setAutonomy(orgA, true);
      const enrId = await seedAwaiting(`tmpl+${stamp}@x.com`, `tmpl:${stamp}`, {
        draftMode: 'template',
        confidence: 0.99,
        groundingOk: true,
      });
      const res = await runAutoApproval(admin, enrId, fake);
      expect(res?.decision).toBe('escalate');
      expect(res?.reason).toBe('not_personalized');

      const enr = await admin
        .from('enrollments')
        .select('status, task_id')
        .eq('id', enrId)
        .single();
      expect(enr.data?.status).toBe('awaiting_approval');
      const task = await admin.from('tasks').select('status').eq('id', enr.data?.task_id).single();
      expect(task.data?.status).toBe('pending');
      const msgs = await admin.from('messages').select('id').eq('enrollment_id', enrId);
      expect((msgs.data ?? []).length).toBe(0);
      const audit = await auditRows(enrId);
      expect(audit[0]?.decision).toBe('escalate');
      expect(audit[0]?.reason).toBe('not_personalized');
    }, 60_000);

    it('low-confidence personalized → escalate (below_confidence_threshold)', async () => {
      await setAutonomy(orgA, true);
      const enrId = await seedAwaiting(`low+${stamp}@x.com`, `low:${stamp}`, {
        draftMode: 'personalized',
        confidence: 0.5,
        groundingOk: true,
      });
      const res = await runAutoApproval(admin, enrId, fake);
      expect(res?.decision).toBe('escalate');
      expect(res?.reason).toBe('below_confidence_threshold');
      expect(
        (await admin.from('messages').select('id').eq('enrollment_id', enrId)).data?.length,
      ).toBe(0);
      expect((await auditRows(enrId))[0]?.reason).toBe('below_confidence_threshold');
    }, 60_000);

    it('unverified personalized → escalate (unverified)', async () => {
      await setAutonomy(orgA, true);
      const enrId = await seedAwaiting(`unv+${stamp}@x.com`, `unv:${stamp}`, {
        draftMode: 'personalized',
        confidence: 0.99,
        groundingOk: false,
      });
      const res = await runAutoApproval(admin, enrId, fake);
      expect(res?.decision).toBe('escalate');
      expect(res?.reason).toBe('unverified');
      expect((await auditRows(enrId))[0]?.reason).toBe('unverified');
    }, 60_000);

    it('autonomy_off → no auto-approval, NO audit row, stays in the human queue (pure Phase-2)', async () => {
      await setAutonomy(orgA, false);
      const enrId = await seedAwaiting(`off+${stamp}@x.com`, `off:${stamp}`, {
        draftMode: 'personalized',
        confidence: 0.99,
        groundingOk: true,
      });
      const res = await runAutoApproval(admin, enrId, fake);
      expect(res).toBeNull();
      const enr = await admin
        .from('enrollments')
        .select('status, task_id')
        .eq('id', enrId)
        .single();
      expect(enr.data?.status).toBe('awaiting_approval');
      const task = await admin.from('tasks').select('status').eq('id', enr.data?.task_id).single();
      expect(task.data?.status).toBe('pending');
      expect((await auditRows(enrId)).length).toBe(0);
    }, 60_000);

    it('THE safety proof: auto_send with sending half-flipped (enabled but dry_run on) → dry_run, ZERO real email', async () => {
      await setAutonomy(orgA, true);
      await setSending(orgA, true, true); // both flags needed for live; dry_run still on → safe
      const enrId = await seedAwaiting(`safe+${stamp}@x.com`, `safe:${stamp}`, {
        draftMode: 'personalized',
        confidence: 0.95,
        groundingOk: true,
      });
      const pushesBefore = addLeadCalls.length;
      const res = await runAutoApproval(admin, enrId, fake);
      expect(res?.decision).toBe('auto_send');
      expect(res?.sendOutcome).toBe('dry_run'); // NOT 'queued' — the two-flag invariant holds
      const msg = await admin.from('messages').select('status').eq('enrollment_id', enrId).single();
      expect(msg.data?.status).toBe('dry_run');
      expect(addLeadCalls.length).toBe(pushesBefore); // never pushed
      await setSending(orgA, false, true); // restore safe default
    }, 90_000);

    it('relaxed reply (interested) → engage decision recorded + ROUTED: replied + needs_action + NOT suppressed (3.3)', async () => {
      await setAutonomy(orgA, true, 'send'); // relaxed reply mode
      const enrId = await seedSent(`reply+${stamp}@x.com`, `rep:${stamp}`);
      const res = await applySmartleadEvent(
        admin,
        {
          event_type: 'EMAIL_REPLY',
          campaign_id: slCampaignId,
          to_email: `reply+${stamp}@x.com`,
          message_id: `rep1-${stamp}`,
          reply_body: 'Sure, let us talk next week',
        },
        { classify: async () => 'interested' as const },
      );
      expect(res.handled).toBe(true);

      // Decision recorded: interested + relaxed → engage.
      const audit = await auditRows(enrId);
      expect(audit.length).toBe(1);
      expect(audit[0]?.kind).toBe('reply');
      expect(audit[0]?.decision).toBe('engage');
      expect(audit[0]?.reason).toBe('interested');

      // 3.3 routing: the sequence HALTS (replied) + a human reviews (needs_action), but engage is
      // NOT globally suppressed (the conversation continues) — the relaxation of the Phase-2 blanket.
      const enr = await admin
        .from('enrollments')
        .select('status, thread_id')
        .eq('id', enrId)
        .single();
      expect(enr.data?.status).toBe('replied');
      const thr = await admin
        .from('threads')
        .select('status')
        .eq('id', enr.data?.thread_id)
        .single();
      expect(thr.data?.status).toBe('needs_action');
      const sup = await admin
        .from('suppression_list')
        .select('reason')
        .eq('organization_id', orgA)
        .eq('email', `reply+${stamp}@x.com`);
      expect((sup.data ?? []).length).toBe(0); // engage → NOT suppressed (3.3)
    }, 60_000);

    it('reply with autonomy_off → NO audit row, same Phase-2 behavior', async () => {
      await setAutonomy(orgA, false);
      const enrId = await seedSent(`reploff+${stamp}@x.com`, `repoff:${stamp}`);
      await applySmartleadEvent(
        admin,
        {
          event_type: 'EMAIL_REPLY',
          campaign_id: slCampaignId,
          to_email: `reploff+${stamp}@x.com`,
          message_id: `repoff1-${stamp}`,
          reply_body: 'interested',
        },
        { classify: async () => 'interested' as const },
      );
      expect((await auditRows(enrId)).length).toBe(0);
      const enr = await admin.from('enrollments').select('status').eq('id', enrId).single();
      expect(enr.data?.status).toBe('replied'); // behavior unchanged
    }, 60_000);

    it('tenant isolation: org B cannot read org A autonomy_events (RLS)', async () => {
      const dbB = createUserClient(tokenB);
      if (!dbB) throw new Error('user-scoped client unavailable');
      const r = await dbB.from('autonomy_events').select('organization_id');
      expect(r.error).toBeNull();
      // org A produced several events above; org B's RLS-scoped read must see NONE of them.
      expect((r.data ?? []).some((row) => row.organization_id === orgA)).toBe(false);
    }, 60_000);
  },
);
