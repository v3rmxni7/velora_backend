import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeReplySend } from '../agents/reply/send.js';
import { runFollowupStep } from '../agents/sending/followup.js';
import { executeSend, isCampaignActive } from '../agents/sending/pipeline.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1) — live DB only (no LLM, no Smartlead): tasks are seeded directly so the
// gates are exercised without a real draft. Proves Slice 4.1a — a paused (non-active) campaign
// blocks every send entry point (cold chokepoint, reply chokepoint, follow-up step), and un-pausing
// resumes. All dry-run; zero real email.
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('Slice 4.1a — campaign-level pause enforcement (DRY-RUN)', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  let orgId = '';
  let campaignId = '';
  let coldEnrollId = '';
  let replyTaskId = '';
  let replyThreadId = '';
  let followupEnrollId = '';

  const setStatus = (status: string) =>
    admin.from('campaigns').update({ status }).eq('id', campaignId);

  async function person(tag: string): Promise<string> {
    const p = await admin
      .from('people')
      .insert({
        organization_id: orgId,
        provider: 'seed',
        external_id: `s41a-${tag}:${stamp}`,
        full_name: `Lead ${tag}`,
        email: `s41a-${tag}+${stamp}@example.com`,
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
      .insert({ name: `s41a-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id as string;
    // Autonomy ON so the follow-up kill-switch passes — we want the campaign-pause gate to be the
    // thing that halts, not autonomy_disabled.
    await admin.from('organizations').update({ autonomy_enabled: true }).eq('id', orgId);

    const campaign = await admin
      .from('campaigns')
      .insert({
        organization_id: orgId,
        name: 'pause-test',
        campaign_type: 'cold_outbound',
        status: 'active',
      })
      .select('id')
      .single();
    if (campaign.error) throw campaign.error;
    campaignId = campaign.data.id as string;
    await admin.from('campaign_steps').insert([
      {
        organization_id: orgId,
        campaign_id: campaignId,
        step_number: 1,
        channel: 'email',
        delay_days: 0,
        body_mode: 'ai_grounded',
      },
      {
        organization_id: orgId,
        campaign_id: campaignId,
        step_number: 2,
        channel: 'email',
        delay_days: 1,
        body_mode: 'ai_grounded',
      },
    ]);

    // Cold: an APPROVED outbound_approval task + an awaiting_approval enrollment (no LLM needed).
    const coldLead = await person('cold');
    const coldTask = await admin
      .from('tasks')
      .insert({
        organization_id: orgId,
        type: 'outbound_approval',
        status: 'approved',
        lead_type: 'person',
        lead_id: coldLead,
        campaign_id: campaignId,
        subject: 'Hi',
        body: 'Hello there.',
      })
      .select('id')
      .single();
    if (coldTask.error) throw coldTask.error;
    const coldEnr = await admin
      .from('enrollments')
      .insert({
        organization_id: orgId,
        campaign_id: campaignId,
        lead_type: 'person',
        lead_id: coldLead,
        status: 'awaiting_approval',
        current_step: 1,
        task_id: coldTask.data.id,
        verified_email: `s41a-cold+${stamp}@example.com`,
        verification: 'deliverable',
      })
      .select('id')
      .single();
    if (coldEnr.error) throw coldEnr.error;
    coldEnrollId = coldEnr.data.id as string;

    // Reply: a thread + an APPROVED reply_approval task + a matching enrollment.
    const replyLead = await person('reply');
    const thread = await admin
      .from('threads')
      .insert({
        organization_id: orgId,
        campaign_id: campaignId,
        lead_type: 'person',
        lead_id: replyLead,
        subject: 'Re: Hi',
        status: 'needs_action',
      })
      .select('id')
      .single();
    if (thread.error) throw thread.error;
    replyThreadId = thread.data.id as string;
    const replyEnr = await admin
      .from('enrollments')
      .insert({
        organization_id: orgId,
        campaign_id: campaignId,
        lead_type: 'person',
        lead_id: replyLead,
        status: 'replied',
        current_step: 1,
        verified_email: `s41a-reply+${stamp}@example.com`,
        thread_id: replyThreadId,
      })
      .select('id')
      .single();
    if (replyEnr.error) throw replyEnr.error;
    const replyTask = await admin
      .from('tasks')
      .insert({
        organization_id: orgId,
        type: 'reply_approval',
        status: 'approved',
        lead_type: 'person',
        lead_id: replyLead,
        campaign_id: campaignId,
        thread_id: replyThreadId,
        subject: 'Re: Hi',
        body: 'Thanks for the reply!',
      })
      .select('id')
      .single();
    if (replyTask.error) throw replyTask.error;
    replyTaskId = replyTask.data.id as string;

    // Follow-up: a 'sent' enrollment at step 1 (ADVANCE CAS would fire if not for the pause gate).
    const folLead = await person('fol');
    const folEnr = await admin
      .from('enrollments')
      .insert({
        organization_id: orgId,
        campaign_id: campaignId,
        lead_type: 'person',
        lead_id: folLead,
        status: 'sent',
        current_step: 1,
        verified_email: `s41a-fol+${stamp}@example.com`,
        verification: 'deliverable',
      })
      .select('id')
      .single();
    if (folEnr.error) throw folEnr.error;
    followupEnrollId = folEnr.data.id as string;
  }, 120_000);

  afterAll(async () => {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
  });

  it('isCampaignActive: true for active, false for paused, false for a missing campaign', async () => {
    await setStatus('active');
    expect(await isCampaignActive(admin, campaignId)).toBe(true);
    await setStatus('paused');
    expect(await isCampaignActive(admin, campaignId)).toBe(false);
    expect(await isCampaignActive(admin, '00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('PAUSED → executeSend returns campaign_paused, writes no message, leaves the enrollment resumable', async () => {
    await setStatus('paused');
    const enr = (await admin.from('enrollments').select('*').eq('id', coldEnrollId).single()).data;
    const res = await executeSend(admin, enr as never);
    expect(res.outcome).toBe('campaign_paused');
    const msgs = await admin.from('messages').select('id').eq('enrollment_id', coldEnrollId);
    expect((msgs.data ?? []).length).toBe(0);
    const after = await admin.from('enrollments').select('status').eq('id', coldEnrollId).single();
    expect(after.data?.status).toBe('awaiting_approval'); // un-pausing resumes it
  });

  it('ACTIVE → executeSend resumes to a dry_run message', async () => {
    await setStatus('active');
    const enr = (await admin.from('enrollments').select('*').eq('id', coldEnrollId).single()).data;
    const res = await executeSend(admin, enr as never);
    expect(res.outcome).toBe('dry_run');
    const msgs = await admin.from('messages').select('status').eq('enrollment_id', coldEnrollId);
    expect((msgs.data ?? []).length).toBe(1);
    expect(msgs.data?.[0]?.status).toBe('dry_run');
  });

  it('PAUSED → executeReplySend returns campaign_paused, writes no reply message', async () => {
    await setStatus('paused');
    const res = await executeReplySend(admin, replyTaskId);
    expect(res.outcome).toBe('campaign_paused');
    const msgs = await admin
      .from('messages')
      .select('id')
      .eq('thread_id', replyThreadId)
      .eq('direction', 'outbound');
    expect((msgs.data ?? []).length).toBe(0);
  });

  it('PAUSED → runFollowupStep halts (campaign_paused) with no advance and no draft', async () => {
    await setStatus('paused');
    const res = await runFollowupStep(admin, followupEnrollId);
    expect(res?.status).toBe('halted');
    expect(res?.reason).toBe('campaign_paused');
    const after = await admin
      .from('enrollments')
      .select('status, current_step, task_id')
      .eq('id', followupEnrollId)
      .single();
    expect(after.data?.status).toBe('sent'); // unchanged — no advance
    expect(after.data?.current_step).toBe(1);
    expect(after.data?.task_id).toBeNull();
  });
});
