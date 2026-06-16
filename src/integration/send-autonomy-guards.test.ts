import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySmartleadEvent } from '../agents/sending/inbound.js';
import { executeSend, prepareEnrollment } from '../agents/sending/pipeline.js';
import { ensureSmartleadCampaign } from '../agents/sending/provision.js';
import { tasksRoute } from '../api/routes/tasks.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';
import type { SmartleadClient } from '../integrations/smartlead/types.js';
import { verdictFromResult } from '../integrations/verifier/millionverifier.js';

// Opt-in (RUN_DB_IT=1). Live DB, FAKE Smartlead client, flags flipped FOR TEST ORGS ONLY, NO real
// email / NO LLM (researcher + classifier stubbed). Each test ENCODES one Gate-2 autonomy finding:
// H1 (reply suppresses the person), H4 (volume governor), H5 (provision race), M2 (reply-mid-send
// CAS), M1 (approve-all through the chokepoint), M5 (no LLM on replays), M7 (non-empty body).
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

function makeFake(): { client: SmartleadClient; pushes: string[]; creates: number } {
  const state = { pushes: [] as string[], creates: 0 };
  const client: SmartleadClient = {
    async listEmailAccounts() {
      return [];
    },
    async getWarmupStats() {
      return {};
    },
    async createCampaign() {
      state.creates += 1;
      return { id: `slc-${Date.now()}-${state.creates}-${Math.round(state.pushes.length)}` };
    },
    async saveSequence() {},
    async assignEmailAccounts() {},
    async setSchedule() {},
    async setStatus() {},
    async addLead(_c, lead) {
      state.pushes.push(lead.email);
    },
    async sendReply() {},
  };
  return {
    client,
    get pushes() {
      return state.pushes;
    },
    get creates() {
      return state.creates;
    },
  };
}

describe.skipIf(!ready)('Slice 2.9 — autonomy guards (Gate 2, zero real email)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  let liveOrg = '';
  // Dry-run org + user token for the M1 route test.
  const m1 = { orgId: '', userId: '', email: `s29m1+${stamp}@example.com`, token: '' };

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
  async function makeCampaign(org: string, slId?: string): Promise<string> {
    const c = await admin
      .from('campaigns')
      .insert({
        organization_id: org,
        name: 'G',
        campaign_type: 'cold_outbound',
        status: 'active',
        ...(slId ? { smartlead_campaign_id: slId } : {}),
      })
      .select('id')
      .single();
    if (c.error) throw c.error;
    return c.data.id as string;
  }
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
    const row = (await admin.from('enrollments').select('*').eq('id', enrId).single()).data;
    await prepareEnrollment(admin, row as never, noFacts, verifier);
    const after = (await admin.from('enrollments').select('task_id').eq('id', enrId).single()).data;
    await admin.from('tasks').update({ status: 'approved' }).eq('id', after?.task_id);
    return enrId;
  }
  async function freshEnr(id: string) {
    const { data, error } = await admin.from('enrollments').select('*').eq('id', id).single();
    if (error || !data) throw error ?? new Error('enrollment not found');
    return data;
  }

  beforeAll(async () => {
    const o = await admin
      .from('organizations')
      .insert({ name: `s29live-${stamp}` })
      .select('id')
      .single();
    if (o.error) throw o.error;
    liveOrg = o.data.id as string;
    await admin.from('coaching_points').insert({ organization_id: liveOrg, content: 'concise' });
    await admin.from('mailboxes').insert({
      organization_id: liveOrg,
      email: `mb-${stamp}@x.com`,
      smartlead_email_account_id: `acct-${stamp}`,
      status: 'warm',
    });
    await admin.from('credit_ledger').insert({
      organization_id: liveOrg,
      delta: 1000,
      reason: 'signup_grant',
      idempotency_key: `grant:${stamp}`,
    });
    await admin
      .from('organizations')
      .update({ sending_enabled: true, sending_dry_run: false })
      .eq('id', liveOrg);

    // M1 dry-run org + a real user/token (route test goes through authenticate).
    const o2 = await admin
      .from('organizations')
      .insert({ name: `s29m1-${stamp}` })
      .select('id')
      .single();
    if (o2.error) throw o2.error;
    m1.orgId = o2.data.id as string;
    const pwd = `Test-${stamp}-pw!`;
    const created = await admin.auth.admin.createUser({
      email: m1.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    m1.userId = created.data.user.id;
    await admin
      .from('users')
      .insert({ id: m1.userId, organization_id: m1.orgId, email: m1.email, role: 'owner' });
    await admin.from('coaching_points').insert({ organization_id: m1.orgId, content: 'concise' });
    const signin = await anon.auth.signInWithPassword({ email: m1.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    m1.token = signin.data.session.access_token;
  }, 240_000);

  afterAll(async () => {
    if (liveOrg) await admin.from('organizations').delete().eq('id', liveOrg);
    if (m1.orgId) await admin.from('organizations').delete().eq('id', m1.orgId);
    if (m1.userId) await admin.auth.admin.deleteUser(m1.userId);
  });

  it('H1 + M5 — a reply suppresses the PERSON globally, classified once; re-enrollment elsewhere is blocked', async () => {
    const email = `h1+${stamp}@x.com`;
    const slA = `sl-h1-${stamp}`;
    const campA = await makeCampaign(liveOrg, slA);
    // A 'sent' enrollment + thread in campaign A, so the reply webhook resolves + can write inbound.
    const leadA = await person(liveOrg, `h1a:${stamp}`, email);
    const thr = await admin
      .from('threads')
      .insert({
        organization_id: liveOrg,
        campaign_id: campA,
        lead_type: 'person',
        lead_id: leadA,
        status: 'active',
      })
      .select('id')
      .single();
    if (thr.error) throw thr.error;
    await admin.from('enrollments').insert({
      organization_id: liveOrg,
      campaign_id: campA,
      lead_type: 'person',
      lead_id: leadA,
      status: 'sent',
      verified_email: email,
      thread_id: thr.data.id,
    });

    let classifyCalls = 0;
    const spyClassify = async () => {
      classifyCalls += 1;
      return 'interested' as const;
    };
    const event = {
      event_type: 'EMAIL_REPLY',
      campaign_id: slA,
      to_email: email,
      message_id: 'h1-r1',
      reply_body: 'thanks, not interested',
    };
    await applySmartleadEvent(admin, event, { classify: spyClassify });
    await applySmartleadEvent(admin, event, { classify: spyClassify }); // replay
    expect(classifyCalls).toBe(1); // M5 — no LLM on the replayed webhook

    const sup = await admin
      .from('suppression_list')
      .select('reason')
      .eq('organization_id', liveOrg)
      .eq('email', email);
    expect(sup.data?.length).toBe(1);
    expect(sup.data?.[0]?.reason).toBe('reply'); // H1 — suppressed with the distinct reason

    // Same person, a DIFFERENT campaign → prepareEnrollment must refuse (cross-campaign block).
    const campB = await makeCampaign(liveOrg);
    const leadB = await person(liveOrg, `h1b:${stamp}`, email);
    const eB = await admin
      .from('enrollments')
      .insert({
        organization_id: liveOrg,
        campaign_id: campB,
        lead_type: 'person',
        lead_id: leadB,
        status: 'pending',
      })
      .select('id')
      .single();
    const res = await prepareEnrollment(
      admin,
      (await freshEnr(eB.data?.id)) as never,
      noFacts,
      null,
    );
    expect(res.outcome).toBe('suppressed');
  }, 120_000);

  it('H4 — the daily volume governor caps fan-out (and a sufficient cap lets it through)', async () => {
    const camp = await makeCampaign(liveOrg);
    const enrId = await approvedEnrollment(
      liveOrg,
      camp,
      `h4+${stamp}@x.com`,
      `h4:${stamp}`,
      okVerifier,
    );
    const fake = makeFake();

    // perOrg:0 trips regardless of counts → deferred, no push, enrollment stays awaiting_approval.
    const blocked = await executeSend(admin, (await freshEnr(enrId)) as never, fake.client, {
      perOrg: 0,
      global: 1_000_000,
    });
    expect(blocked.outcome).toBe('rate_limited');
    expect(fake.pushes.length).toBe(0);
    expect((await freshEnr(enrId))?.status).toBe('awaiting_approval');

    // Sufficient caps → the same enrollment now sends.
    const sent = await executeSend(admin, (await freshEnr(enrId)) as never, fake.client, {
      perOrg: 50,
      global: 1_000_000,
    });
    expect(sent.outcome).toBe('queued');
    expect(fake.pushes.length).toBe(1);
  }, 120_000);

  it('H5 — concurrent provisioning creates exactly ONE Smartlead campaign', async () => {
    const camp = await makeCampaign(liveOrg);
    const fake = makeFake();
    const ref = { id: camp, organization_id: liveOrg, name: 'race', smartlead_campaign_id: null };
    const results = await Promise.allSettled([
      ensureSmartleadCampaign(admin, ref, fake.client),
      ensureSmartleadCampaign(admin, ref, fake.client),
    ]);
    expect(fake.creates).toBe(1); // never double-created
    const ids = results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
      .map((r) => r.value);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    for (const id of ids) expect(id).toBe(ids[0]); // all fulfilled callers agree on the one id
  }, 120_000);

  it('M2 — a reply that lands mid-send halts the push (compare-and-swap)', async () => {
    const camp = await makeCampaign(liveOrg);
    const enrId = await approvedEnrollment(
      liveOrg,
      camp,
      `m2+${stamp}@x.com`,
      `m2:${stamp}`,
      okVerifier,
    );
    // Simulate the reply having flipped the enrollment out of the sendable state mid-flight.
    await admin.from('enrollments').update({ status: 'replied' }).eq('id', enrId);
    const fake = makeFake();
    const res = await executeSend(admin, (await freshEnr(enrId)) as never, fake.client);
    expect(res.outcome).toBe('halted');
    expect(fake.pushes.length).toBe(0);
  }, 120_000);

  it('M7 — an empty draft body is refused at the chokepoint', async () => {
    const camp = await makeCampaign(liveOrg);
    const enrId = await approvedEnrollment(
      liveOrg,
      camp,
      `m7+${stamp}@x.com`,
      `m7:${stamp}`,
      okVerifier,
    );
    const taskId = (await freshEnr(enrId))?.task_id;
    await admin.from('tasks').update({ body: '   ' }).eq('id', taskId); // whitespace-only
    const fake = makeFake();
    const res = await executeSend(admin, (await freshEnr(enrId)) as never, fake.client);
    expect(res.outcome).toBe('invalid');
    expect(fake.pushes.length).toBe(0);
    const after = await admin.from('enrollments').select('status, error').eq('id', enrId).single();
    expect(after.data?.status).toBe('failed');
    expect(after.data?.error).toBe('empty_draft');
  }, 120_000);

  it('M1 — approve-all routes every task through executeSend (inherits the suppression gate)', async () => {
    const db = createUserClient(m1.token);
    if (!db) throw new Error('user client unavailable');
    const camp = await makeCampaign(m1.orgId); // dry-run org

    // Two normal enrollments + one whose address is suppressed.
    const ids: string[] = [];
    for (const tag of ['a', 'b', 'sup']) {
      const email = `m1-${tag}+${stamp}@x.com`;
      const leadId = await person(m1.orgId, `m1${tag}:${stamp}`, email);
      const e = await admin
        .from('enrollments')
        .insert({
          organization_id: m1.orgId,
          campaign_id: camp,
          lead_type: 'person',
          lead_id: leadId,
          status: 'pending',
        })
        .select('id')
        .single();
      await prepareEnrollment(admin, (await freshEnr(e.data?.id)) as never, noFacts, okVerifier);
      ids.push(e.data?.id as string);
      if (tag === 'sup') {
        await admin
          .from('suppression_list')
          .insert({ organization_id: m1.orgId, email, reason: 'manual', source: 'test' });
      }
    }

    const app = Fastify();
    await app.register(tasksRoute);
    const resp = await app.inject({
      method: 'POST',
      url: '/tasks/approve-all',
      headers: { authorization: `Bearer ${m1.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    await app.close();
    expect(resp.statusCode).toBe(200);
    const body = resp.json() as { approved: number; sent: Record<string, number> };
    expect(body.approved).toBe(3);
    // Bulk approve flowed through executeSend: 2 dry-run sends + 1 blocked by suppression.
    expect(body.sent.dry_run).toBe(2);
    expect(body.sent.suppressed).toBe(1);
  }, 180_000);
});
