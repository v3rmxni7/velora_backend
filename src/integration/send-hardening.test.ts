import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeSend, prepareEnrollment } from '../agents/sending/pipeline.js';
import { ensureSmartleadCampaign } from '../agents/sending/provision.js';
import { env } from '../config/env.js';
import type { SmartleadClient } from '../integrations/smartlead/types.js';
import { verdictFromResult } from '../integrations/verifier/millionverifier.js';

// Opt-in (RUN_DB_IT=1). Live DB, FAKE Smartlead client, flags flipped FOR THE TEST ORG ONLY,
// NO real email / NO LLM (researcher stubbed). Each test ENCODES one audit Gate-1 finding so it
// can never silently regress: C1 (no re-send on retry), H3 (verification fail-closed), H2 (warm-only
// sending), M3 (suppression vs the sent address), M4 (unique smartlead_campaign_id).
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const noFacts = { researcher: async () => ({ facts: [], allowedRefs: new Set<string>() }) };
const okVerifier = {
  async verify() {
    return { result: 'ok', verdict: verdictFromResult('ok') };
  },
};

// A fake Smartlead client that records every push and mints a UNIQUE campaign id per call (so the
// new unique index on smartlead_campaign_id is never violated across the suite's campaigns).
function makeFake(): { client: SmartleadClient; pushes: string[]; failNextPush: () => void } {
  const pushes: string[] = [];
  let counter = 0;
  let fail = false;
  const client: SmartleadClient = {
    async listEmailAccounts() {
      return [];
    },
    async getWarmupStats() {
      return {};
    },
    async createCampaign() {
      counter += 1;
      return { id: `slc-${Date.now()}-${counter}` };
    },
    async saveSequence() {},
    async assignEmailAccounts() {},
    async setSchedule() {},
    async setStatus() {},
    async addLead(_c, lead) {
      pushes.push(lead.email);
      if (fail) {
        fail = false;
        throw new Error('simulated push failure (delivery uncertain)');
      }
    },
  };
  return { client, pushes, failNextPush: () => (fail = true) };
}

describe.skipIf(!ready)('Slice 2.8 hardening — Gate-1 regressions (zero real email)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  let orgA = '';

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
  async function makeCampaign(org: string): Promise<string> {
    const c = await admin
      .from('campaigns')
      .insert({ organization_id: org, name: 'H', campaign_type: 'cold_outbound', status: 'active' })
      .select('id')
      .single();
    if (c.error) throw c.error;
    return c.data.id as string;
  }
  // pending enrollment → prepare (with the chosen verifier, which sets enrollment.verification) →
  // approve its task. Returns the enrollment id, ready for executeSend.
  async function approvedEnrollment(
    org: string,
    campaign: string,
    email: string,
    ext: string,
    verifier: typeof okVerifier | null,
  ): Promise<string> {
    const leadId = await person(org, ext, email);
    const e = await admin
      .from('enrollments')
      .insert({
        organization_id: org,
        campaign_id: campaign,
        lead_type: 'person',
        lead_id: leadId,
        status: 'pending',
      })
      .select('id')
      .single();
    if (e.error) throw e.error;
    const enrId = e.data.id as string;
    const enr = (await admin.from('enrollments').select('*').eq('id', enrId).single()).data;
    await prepareEnrollment(admin, enr as never, noFacts, verifier);
    const after = (await admin.from('enrollments').select('task_id').eq('id', enrId).single()).data;
    await admin.from('tasks').update({ status: 'approved' }).eq('id', after?.task_id);
    return enrId;
  }
  async function warmMailbox(org: string, acct: string) {
    await admin.from('mailboxes').insert({
      organization_id: org,
      email: `${acct}@x.com`,
      smartlead_email_account_id: acct,
      status: 'warm',
    });
  }

  beforeAll(async () => {
    const org = await admin
      .from('organizations')
      .insert({ name: `s28-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    orgA = org.data.id as string;
    await admin.from('coaching_points').insert({ organization_id: orgA, content: 'concise' });
    await warmMailbox(orgA, `acct-${stamp}`);
    await admin.from('credit_ledger').insert({
      organization_id: orgA,
      delta: 100,
      reason: 'signup_grant',
      idempotency_key: `grant:${stamp}`,
    });
    // THE DELIBERATE FLIP — this test org only.
    await admin
      .from('organizations')
      .update({ sending_enabled: true, sending_dry_run: false })
      .eq('id', orgA);
  }, 180_000);

  afterAll(async () => {
    if (orgA) await admin.from('organizations').delete().eq('id', orgA);
  });

  it('C1 — a retry after a post-push failure does NOT re-send (claim-before-push)', async () => {
    const camp = await makeCampaign(orgA);
    const enrId = await approvedEnrollment(
      orgA,
      camp,
      `c1+${stamp}@x.com`,
      `c1:${stamp}`,
      okVerifier,
    );
    const fake = makeFake();
    fake.failNextPush(); // push records the call, then throws → delivery uncertain

    const enr = (await admin.from('enrollments').select('*').eq('id', enrId).single()).data;
    await expect(executeSend(admin, enr as never, fake.client)).rejects.toThrow();
    expect(fake.pushes.length).toBe(1); // pushed once
    const failed = await admin.from('enrollments').select('status, error').eq('id', enrId).single();
    expect(failed.data?.status).toBe('failed');
    expect(failed.data?.error).toBe('send_push_failed');

    // Retry — the claim row already exists, so executeSend must short-circuit WITHOUT re-pushing.
    const enr2 = (await admin.from('enrollments').select('*').eq('id', enrId).single()).data;
    const res = await executeSend(admin, enr2 as never, fake.client);
    expect(res.outcome).toBe('duplicate');
    expect(fake.pushes.length).toBe(1); // STILL one push — no double-send

    // And no credit was charged for an uncertain/failed send.
    const debits = await admin
      .from('credit_ledger')
      .select('id')
      .eq('organization_id', orgA)
      .eq('reason', 'send')
      .like('idempotency_key', `send:${orgA}:${enrId}:%`);
    expect((debits.data ?? []).length).toBe(0);
  }, 90_000);

  it('H3 — live send fails CLOSED when verification was skipped (no verifier)', async () => {
    const camp = await makeCampaign(orgA);
    // prepared with NO verifier → enrollment.verification = 'skipped'
    const enrId = await approvedEnrollment(orgA, camp, `h3+${stamp}@x.com`, `h3:${stamp}`, null);
    const fake = makeFake();
    const enr = (await admin.from('enrollments').select('*').eq('id', enrId).single()).data;
    const res = await executeSend(admin, enr as never, fake.client);
    expect(res.outcome).toBe('verification_required');
    expect(fake.pushes.length).toBe(0); // never pushed an unverified address
    const after = await admin.from('enrollments').select('status, error').eq('id', enrId).single();
    expect(after.data?.status).toBe('failed');
    expect(after.data?.error).toBe('verification_unavailable');
  }, 90_000);

  it('M3 — suppression re-check follows the SENT address (verified_email), not the editable lead email', async () => {
    const camp = await makeCampaign(orgA);
    const sentAddr = `m3-sent+${stamp}@x.com`;
    const enrId = await approvedEnrollment(orgA, camp, sentAddr, `m3:${stamp}`, okVerifier);
    // Suppress the address we'd actually send to (the frozen verified_email)…
    await admin
      .from('suppression_list')
      .insert({ organization_id: orgA, email: sentAddr, reason: 'manual', source: 'test' });
    // …then edit the raw lead email to a DIFFERENT, clean address. The old code checked this one.
    const enrRow = (await admin.from('enrollments').select('lead_id').eq('id', enrId).single())
      .data;
    await admin
      .from('people')
      .update({ email: `m3-clean+${stamp}@x.com` })
      .eq('id', enrRow?.lead_id);

    const fake = makeFake();
    const enr = (await admin.from('enrollments').select('*').eq('id', enrId).single()).data;
    const res = await executeSend(admin, enr as never, fake.client);
    expect(res.outcome).toBe('suppressed'); // blocked on the SENT address
    expect(fake.pushes.length).toBe(0);
  }, 90_000);

  it('H2 — provisioning rejects cold/connected mailboxes and accepts only warm', async () => {
    const fake = makeFake();
    // org with only a 'connected' (cold) mailbox → refuse to send.
    const coldOrg = (
      await admin
        .from('organizations')
        .insert({ name: `s28cold-${stamp}` })
        .select('id')
        .single()
    ).data;
    const coldOrgId = coldOrg?.id as string;
    try {
      await admin.from('mailboxes').insert({
        organization_id: coldOrgId,
        email: `cold-${stamp}@x.com`,
        smartlead_email_account_id: `cold-${stamp}`,
        status: 'connected',
      });
      const coldCamp = await makeCampaign(coldOrgId);
      await expect(
        ensureSmartleadCampaign(
          admin,
          { id: coldCamp, organization_id: coldOrgId, name: 'cold', smartlead_campaign_id: null },
          fake.client,
        ),
      ).rejects.toMatchObject({ code: 'no_mailboxes' });

      // Promote to warm → provisioning succeeds.
      await admin.from('mailboxes').update({ status: 'warm' }).eq('organization_id', coldOrgId);
      const id = await ensureSmartleadCampaign(
        admin,
        { id: coldCamp, organization_id: coldOrgId, name: 'warm', smartlead_campaign_id: null },
        fake.client,
      );
      expect(id).toMatch(/^slc-/);
    } finally {
      if (coldOrgId) await admin.from('organizations').delete().eq('id', coldOrgId);
    }
  }, 90_000);

  it('M4 — campaigns.smartlead_campaign_id is unique (duplicate insert rejected)', async () => {
    const dup = `dup-${stamp}`;
    const first = await admin
      .from('campaigns')
      .insert({ organization_id: orgA, name: 'd1', smartlead_campaign_id: dup })
      .select('id')
      .single();
    expect(first.error).toBeNull();
    const second = await admin
      .from('campaigns')
      .insert({ organization_id: orgA, name: 'd2', smartlead_campaign_id: dup });
    expect(second.error?.code).toBe('23505');
  }, 60_000);
});
