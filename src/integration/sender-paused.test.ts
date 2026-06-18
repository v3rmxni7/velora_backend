import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeReplySend } from '../agents/reply/send.js';
import { executeSend } from '../agents/sending/pipeline.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1) — live DB, no LLM/Smartlead (tasks seeded directly). Proves Slice 4.8a: a
// paused/setup ASSIGNED SENDER blocks BOTH send chokepoints (cold executeSend + reply
// executeReplySend), so "pausing a sender stops its sends" is honest. All dry-run; zero real email.
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('Slice 4.8a — sender-status send gate (DRY-RUN)', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  let orgId = '';
  let senderId = '';
  let campaignId = '';
  let coldEnrollId = '';
  let replyTaskId = '';
  let replyThreadId = '';

  const setSenderStatus = (status: string) =>
    admin.from('senders').update({ status }).eq('id', senderId);

  async function person(tag: string): Promise<string> {
    const p = await admin
      .from('people')
      .insert({
        organization_id: orgId,
        provider: 'seed',
        external_id: `sp-${tag}:${stamp}`,
        full_name: `Lead ${tag}`,
        email: `sp-${tag}+${stamp}@example.com`,
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
      .insert({ name: `sp-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id as string;
    const sender = await admin
      .from('senders')
      .insert({ organization_id: orgId, display_name: 'SP Sender', status: 'active' })
      .select('id')
      .single();
    if (sender.error) throw sender.error;
    senderId = sender.data.id as string;
    const campaign = await admin
      .from('campaigns')
      .insert({
        organization_id: orgId,
        name: 'sp',
        campaign_type: 'cold_outbound',
        status: 'active',
        sender_id: senderId,
      })
      .select('id')
      .single();
    if (campaign.error) throw campaign.error;
    campaignId = campaign.data.id as string;

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
        verified_email: `sp-cold+${stamp}@example.com`,
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
    await admin
      .from('enrollments')
      .insert({
        organization_id: orgId,
        campaign_id: campaignId,
        lead_type: 'person',
        lead_id: replyLead,
        status: 'replied',
        current_step: 1,
        verified_email: `sp-reply+${stamp}@example.com`,
        thread_id: replyThreadId,
      })
      .select('id')
      .single();
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
  }, 120_000);

  afterAll(async () => {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
  });

  it('PAUSED sender → executeSend returns sender_paused, writes no message, leaves the enrollment resumable', async () => {
    await setSenderStatus('paused');
    const enr = (await admin.from('enrollments').select('*').eq('id', coldEnrollId).single()).data;
    const res = await executeSend(admin, enr as never);
    expect(res.outcome).toBe('sender_paused');
    const msgs = await admin.from('messages').select('id').eq('enrollment_id', coldEnrollId);
    expect((msgs.data ?? []).length).toBe(0);
    const after = await admin.from('enrollments').select('status').eq('id', coldEnrollId).single();
    expect(after.data?.status).toBe('awaiting_approval'); // un-pausing the sender resumes it
  }, 60_000);

  it('ACTIVE sender → executeSend resumes to a dry_run message', async () => {
    await setSenderStatus('active');
    const enr = (await admin.from('enrollments').select('*').eq('id', coldEnrollId).single()).data;
    const res = await executeSend(admin, enr as never);
    expect(res.outcome).toBe('dry_run');
    const msgs = await admin.from('messages').select('status').eq('enrollment_id', coldEnrollId);
    expect((msgs.data ?? []).length).toBe(1);
    expect(msgs.data?.[0]?.status).toBe('dry_run');
  }, 60_000);

  it('PAUSED sender → executeReplySend returns sender_paused, writes no reply message', async () => {
    await setSenderStatus('paused');
    const res = await executeReplySend(admin, replyTaskId);
    expect(res.outcome).toBe('sender_paused');
    const msgs = await admin
      .from('messages')
      .select('id')
      .eq('thread_id', replyThreadId)
      .eq('direction', 'outbound');
    expect((msgs.data ?? []).length).toBe(0);
  }, 60_000);
});
