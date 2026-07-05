import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GenerateDeps } from '../agents/draft/generate.js';
import { runFollowupStep } from '../agents/sending/followup.js';
import { env } from '../config/env.js';
import type { SmartleadClient } from '../integrations/smartlead/types.js';

// Opt-in (RUN_DB_IT=1). Live DB, FAKE Smartlead, STUBBED draft pipeline (no LLM/embedding), flags
// flipped FOR THE TEST ORG ONLY. Proves Slice 3.2: the follow-up sequencer advances a step through
// 3.1's auto-approval (dry-run, ZERO real email), and — the critical property — HALTS the sequence
// the moment the enrollment is no longer sendable (reply/bounce/unsub/suppression/kill-switch).
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// Stubbed pipeline → a deterministic PERSONALIZED, verified, high-confidence draft (no LLM/embedding).
const personalizedDeps: GenerateDeps = {
  researcher: async () => ({
    facts: [
      {
        id: 'f1',
        text: 'leads engineering',
        sourceType: 'lead_field',
        sourceRef: 'title',
        confidence: 0.95,
      },
      {
        id: 'p1',
        text: 'cut onboarding 40%',
        sourceType: 'proof_item',
        sourceRef: 'proof.p1',
        confidence: 0.95,
      },
    ],
    allowedRefs: new Set(['title', 'proof.p1']),
  }),
  writer: async () => ({
    subject: 'Following up',
    body: 'Following up on my note — we cut onboarding 40%.',
    usedFactIds: ['p1'],
  }),
};

describe.skipIf(!ready)(
  'Slice 3.2 — multi-step follow-up sequencer (dry-run, zero real email)',
  () => {
    const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const stamp = Date.now();
    let orgId = '';
    let campaignId = '';

    const addLeadCalls: { email: string }[] = [];
    const fake: SmartleadClient = {
      async listEmailAccounts() {
        return [];
      },
      async getWarmupStats() {
        return {};
      },
      async createCampaign() {
        return { id: `sl-${stamp}` };
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

    async function setAutonomy(enabled: boolean) {
      const r = await admin
        .from('organizations')
        .update({ autonomy_enabled: enabled, auto_send_min_confidence: 0.8 })
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
    // A lead deliberately WITHOUT title/company so generateDraft skips the KB embedding (no network);
    // the stubbed researcher provides the grounded facts regardless.
    async function person(email: string, ext: string): Promise<string> {
      const p = await admin
        .from('people')
        .insert({
          organization_id: orgId,
          provider: 'seed',
          external_id: ext,
          full_name: 'Lead',
          email,
          source: 'find_leads',
        })
        .select('id')
        .single();
      if (p.error) throw p.error;
      return p.data.id as string;
    }
    // Seed an enrollment in the post-step-1 state (status, current_step=1, verified address).
    async function seedPostStep1(email: string, ext: string, status: string): Promise<string> {
      const leadId = await person(email, ext);
      const e = await admin
        .from('enrollments')
        .insert({
          organization_id: orgId,
          campaign_id: campaignId,
          lead_type: 'person',
          lead_id: leadId,
          status,
          current_step: 1,
          verified_email: email,
          verification: 'deliverable',
        })
        .select('id')
        .single();
      if (e.error) throw e.error;
      return e.data.id as string;
    }
    async function stepMessages(enrollmentId: string, stepSuffix: string) {
      const r = await admin
        .from('messages')
        .select('id, status, dedupe_key')
        .eq('enrollment_id', enrollmentId)
        .like('dedupe_key', `%:${stepSuffix}`);
      if (r.error) throw r.error;
      return r.data ?? [];
    }
    async function autoSendAudits(enrollmentId: string) {
      const r = await admin
        .from('autonomy_events')
        .select('decision')
        .eq('enrollment_id', enrollmentId)
        .eq('kind', 'cold_send')
        .eq('decision', 'auto_send');
      if (r.error) throw r.error;
      return r.data ?? [];
    }

    beforeAll(async () => {
      const o = await admin
        .from('organizations')
        .insert({ name: `s32-${stamp}` })
        .select('id')
        .single();
      if (o.error) throw o.error;
      orgId = o.data.id as string;
      const c = await admin
        .from('campaigns')
        .insert({
          organization_id: orgId,
          name: 'Seq',
          campaign_type: 'cold_outbound',
          status: 'active',
        })
        .select('id')
        .single();
      if (c.error) throw c.error;
      campaignId = c.data.id as string;
      // A 2-step sequence: step 1 (immediate) + step 2 (follow-up after 3 days).
      const steps = await admin.from('campaign_steps').insert([
        { organization_id: orgId, campaign_id: campaignId, step_number: 1, delay_days: 0 },
        { organization_id: orgId, campaign_id: campaignId, step_number: 2, delay_days: 3 },
      ]);
      if (steps.error) throw steps.error;
      await admin.from('coaching_points').insert({ organization_id: orgId, content: 'concise' });
    }, 180_000);

    afterAll(async () => {
      if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    });

    it('ADVANCE: a still-sent enrollment advances → step-2 draft generated + auto-approved + dry_run, ZERO push', async () => {
      await setAutonomy(true);
      await setSending(false, true);
      const enrId = await seedPostStep1(`adv+${stamp}@x.com`, `adv:${stamp}`, 'sent');
      const before = addLeadCalls.length;

      const res = await runFollowupStep(admin, enrId, fake, personalizedDeps);
      expect(res?.status).toBe('advanced');
      expect(res?.step).toBe(2);
      expect(res?.sendOutcome).toBe('dry_run');

      const enr = await admin
        .from('enrollments')
        .select('status, current_step')
        .eq('id', enrId)
        .single();
      expect(enr.data?.current_step).toBe(2);
      expect(enr.data?.status).toBe('sent');

      const msgs = await stepMessages(enrId, '2'); // dedupe send:…:2
      expect(msgs.length).toBe(1);
      expect(msgs[0]?.status).toBe('dry_run');

      // A NEW, step-namespaced draft task exists (…:s2) — distinct from a step-1 draft.
      const t = await admin
        .from('tasks')
        .select('id')
        .eq('organization_id', orgId)
        .like('dedupe_key', '%:s2');
      expect((t.data ?? []).length).toBe(1);

      expect((await autoSendAudits(enrId)).length).toBe(1);
      expect(addLeadCalls.length).toBe(before); // dry-run → nothing pushed
    }, 90_000);

    it('THE HALT PROOF: a terminal status between steps STOPS the sequence (no step-2 send)', async () => {
      await setAutonomy(true);
      await setSending(false, true);
      for (const status of ['replied', 'bounced', 'unsubscribed']) {
        const enrId = await seedPostStep1(
          `halt-${status}+${stamp}@x.com`,
          `halt:${status}:${stamp}`,
          status,
        );
        const res = await runFollowupStep(admin, enrId, fake, personalizedDeps);
        expect(res?.status).toBe('halted');
        expect(res?.reason).toBe('not_sendable');
        const enr = await admin.from('enrollments').select('current_step').eq('id', enrId).single();
        expect(enr.data?.current_step).toBe(1); // never advanced
        expect((await stepMessages(enrId, '2')).length).toBe(0); // no step-2 message
        expect((await autoSendAudits(enrId)).length).toBe(0); // no auto_send decision
      }
    }, 120_000);

    it('HALT on suppression: a suppressed recipient stops the follow-up', async () => {
      await setAutonomy(true);
      const email = `sup+${stamp}@x.com`;
      const enrId = await seedPostStep1(email, `sup:${stamp}`, 'sent');
      await admin
        .from('suppression_list')
        .insert({ organization_id: orgId, email, reason: 'unsubscribe', source: 'manual' });
      const res = await runFollowupStep(admin, enrId, fake, personalizedDeps);
      expect(res?.status).toBe('halted');
      expect(res?.reason).toBe('suppressed');
      expect((await stepMessages(enrId, '2')).length).toBe(0);
    }, 60_000);

    it('HUMAN-APPROVAL MODE: autonomy off ESCALATES the follow-up to the Tasks queue (draft, no auto-send)', async () => {
      // Autonomy off is the human-approval posture — the sequence must CONTINUE as a human task, not
      // die. The step advances + drafts, but runAutoApproval escalates (no auto_send); the true stop
      // is a paused campaign (which halts at the isCampaignActive gate), not autonomy-off.
      await setAutonomy(false);
      const enrId = await seedPostStep1(`kill+${stamp}@x.com`, `kill:${stamp}`, 'sent');
      const res = await runFollowupStep(admin, enrId, fake, personalizedDeps);
      expect(res?.status).toBe('escalated');
      expect(res?.step).toBe(2);
      // Advanced to step 2 and a draft task exists for human review — but NO send happened.
      const enr = await admin
        .from('enrollments')
        .select('current_step, status, task_id')
        .eq('id', enrId)
        .single();
      expect(enr.data?.current_step).toBe(2);
      expect(enr.data?.status).toBe('awaiting_approval');
      expect(enr.data?.task_id).toBeTruthy();
      expect((await autoSendAudits(enrId)).length).toBe(0); // no auto_send decision
    }, 60_000);

    it('IDEMPOTENCY: re-running the sequencer produces no second step-2 message', async () => {
      await setAutonomy(true);
      await setSending(false, true);
      const enrId = await seedPostStep1(`idem+${stamp}@x.com`, `idem:${stamp}`, 'sent');
      const first = await runFollowupStep(admin, enrId, fake, personalizedDeps);
      expect(first?.status).toBe('advanced');
      // Second run: current_step is now 2; the advance CAS (where current_step=1) matches 0 rows, and
      // there is no step 3 → no-op. Exactly one step-2 message remains.
      const second = await runFollowupStep(admin, enrId, fake, personalizedDeps);
      expect(second?.status === 'completed' || second?.status === 'halted').toBe(true);
      expect((await stepMessages(enrId, '2')).length).toBe(1);
    }, 90_000);

    it('TWO-FLAG invariant: auto follow-up with sending half-flipped → dry_run only, ZERO push', async () => {
      await setAutonomy(true);
      await setSending(true, true); // both needed for live; dry_run still on → safe
      const enrId = await seedPostStep1(`twoflag+${stamp}@x.com`, `tf:${stamp}`, 'sent');
      const before = addLeadCalls.length;
      const res = await runFollowupStep(admin, enrId, fake, personalizedDeps);
      expect(res?.status).toBe('advanced');
      expect(res?.sendOutcome).toBe('dry_run');
      expect((await stepMessages(enrId, '2'))[0]?.status).toBe('dry_run');
      expect(addLeadCalls.length).toBe(before);
      await setSending(false, true);
    }, 90_000);
  },
);
