import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyticsRoute } from '../api/routes/analytics.js';
import { dialerRoute } from '../api/routes/dialer.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// Opt-in (RUN_DB_IT=1). Live DB; routes via app.inject + real JWTs. Proves Slice 4.9a: the calls RLS
// quartet + cross-tenant isolation; idempotent add-to-queue (one open row), skip, log (logged_by from
// the JWT); the brief assembles from REAL data (lead + thread + messages + grounding) and is
// honest-empty WITHOUT an LLM (talkingPoints unavailable, no fabricated points); NO credit debit; and
// honest dialer analytics (0 → no connectRate; real once logged, org-isolated). No calls are placed.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

interface Acct {
  orgId: string;
  userId: string;
  email: string;
  token: string;
}

describe.skipIf(!ready)('Slice 4.9a — dialer (queue + brief + manual log, no real calls)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a: Acct = { orgId: '', userId: '', email: `dialer-a+${stamp}@example.com`, token: '' };
  const b: Acct = { orgId: '', userId: '', email: `dialer-b+${stamp}@example.com`, token: '' };
  let personId = ''; // org A person with a thread + messages + grounding
  let freshPersonId = ''; // org A person with no thread (brief honest-empty)

  async function makeAcct(o: Acct, tag: string) {
    const org = await admin
      .from('organizations')
      .insert({ name: `dialer-${tag}-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    o.orgId = org.data.id as string;
    const created = await admin.auth.admin.createUser({
      email: o.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    o.userId = created.data.user.id;
    await admin
      .from('users')
      .insert({ id: o.userId, organization_id: o.orgId, email: o.email, role: 'owner' });
    const signin = await anon.auth.signInWithPassword({ email: o.email, password: pwd });
    o.token = signin.data.session?.access_token as string;
  }

  async function inject(method: 'GET' | 'POST', url: string, token: string, payload?: unknown) {
    const app = Fastify();
    await app.register(dialerRoute);
    await app.register(analyticsRoute);
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    await app.close();
    return res;
  }

  const newCallId = async (leadId: string): Promise<string> => {
    const res = await inject('POST', '/dialer/calls', a.token, { leadType: 'person', leadId });
    return res.json().data.id as string;
  };

  beforeAll(async () => {
    await makeAcct(a, 'a');
    await makeAcct(b, 'b');
    const p = await admin
      .from('people')
      .insert({
        organization_id: a.orgId,
        provider: 'seed',
        external_id: `d-p:${stamp}`,
        full_name: 'Dana Caller',
        title: 'VP Ops',
        email: `dana+${stamp}@x.com`,
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (p.error) throw p.error;
    personId = p.data.id as string;
    const fp = await admin
      .from('people')
      .insert({
        organization_id: a.orgId,
        provider: 'seed',
        external_id: `d-fp:${stamp}`,
        full_name: 'Fresh Lead',
        email: `fresh+${stamp}@x.com`,
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (fp.error) throw fp.error;
    freshPersonId = fp.data.id as string;

    const camp = await admin
      .from('campaigns')
      .insert({
        organization_id: a.orgId,
        name: 'd',
        campaign_type: 'cold_outbound',
        status: 'active',
      })
      .select('id')
      .single();
    const thread = await admin
      .from('threads')
      .insert({
        organization_id: a.orgId,
        campaign_id: camp.data?.id,
        lead_type: 'person',
        lead_id: personId,
        subject: 'Re: Hi',
        status: 'needs_action',
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (thread.error) throw thread.error;
    await admin.from('messages').insert([
      {
        organization_id: a.orgId,
        thread_id: thread.data.id,
        direction: 'outbound',
        channel: 'email',
        subject: 'Hi',
        body: 'Quick intro to our product.',
        status: 'sent',
        created_at: new Date(stamp - 60_000).toISOString(),
      },
      {
        organization_id: a.orgId,
        thread_id: thread.data.id,
        direction: 'inbound',
        channel: 'email',
        subject: 'Re: Hi',
        body: 'Interested — can you call me?',
        status: 'replied',
        category: 'interested',
        created_at: new Date(stamp).toISOString(),
      },
    ]);
    await admin.from('proof_items').insert({
      organization_id: a.orgId,
      category: 'case_study',
      title: 'Acme cut ramp 40%',
      body: 'Acme onboarded in a week.',
    });
    await admin
      .from('coaching_points')
      .insert({ organization_id: a.orgId, content: 'Lead with the ramp-time win.' });
  }, 180_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('add-to-queue: creates a queued call + writes a rep-typed phone back to the person', async () => {
    const res = await inject('POST', '/dialer/calls', a.token, {
      leadType: 'person',
      leadId: personId,
      phone: '+1-555-0100',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ status: 'queued', phone: '+1-555-0100' });
    const person = await admin.from('people').select('phone').eq('id', personId).single();
    expect(person.data?.phone).toBe('+1-555-0100'); // write-back so the tel: link works
  }, 60_000);

  it('idempotent: re-adding the same lead returns the existing open call (no duplicate)', async () => {
    const again = await inject('POST', '/dialer/calls', a.token, {
      leadType: 'person',
      leadId: personId,
    });
    expect([200, 201]).toContain(again.statusCode);
    const open = await admin
      .from('calls')
      .select('id')
      .eq('organization_id', a.orgId)
      .eq('lead_id', personId)
      .in('status', ['queued', 'scheduled']);
    expect((open.data ?? []).length).toBe(1);
  }, 60_000);

  it('the Ready tab lists the call with the lead name', async () => {
    const res = await inject('GET', '/dialer/calls?tab=ready', a.token);
    expect(res.statusCode).toBe(200);
    const row = (res.json().data as { lead_id: string; leadName: string }[]).find(
      (c) => c.lead_id === personId,
    );
    expect(row?.leadName).toBe('Dana Caller');
  }, 60_000);

  it('cross-tenant: org B cannot read org A calls nor insert into A', async () => {
    const bDb = createUserClient(b.token);
    if (!bDb) throw new Error('no client');
    const read = await bDb.from('calls').select('id').eq('organization_id', a.orgId);
    expect((read.data ?? []).length).toBe(0);
    const forge = await bDb
      .from('calls')
      .insert({ organization_id: a.orgId, lead_type: 'person', lead_id: personId })
      .select('id');
    expect(forge.error).toBeTruthy(); // RLS WITH CHECK denies a cross-org insert
    const bList = await inject('GET', '/dialer/calls?tab=ready', b.token);
    expect((bList.json().data as unknown[]).length).toBe(0);
  }, 60_000);

  it('brief: assembles from REAL data (lead + thread + grounding); honest-empty without an LLM', async () => {
    const open = await admin
      .from('calls')
      .select('id')
      .eq('organization_id', a.orgId)
      .eq('lead_id', personId)
      .in('status', ['queued', 'scheduled'])
      .single();
    const res = await inject('GET', `/dialer/calls/${open.data?.id}/brief`, a.token);
    expect(res.statusCode).toBe(200);
    const brief = res.json().data;
    expect(brief.lead.name).toBe('Dana Caller');
    expect(brief.pastInteractions.threadCount).toBe(1);
    expect(brief.pastInteractions.summary.length).toBe(2);
    expect(brief.grounding.proofItems.length).toBeGreaterThanOrEqual(1);
    expect(brief.grounding.coachingPoints.length).toBeGreaterThanOrEqual(1);
    // The LLM synthesis is honestly unavailable — never fabricated.
    expect(brief.talkingPoints).toEqual({ status: 'unavailable', items: [] });

    // A fresh lead with no thread → honest-empty past interactions, still no fabricated talking points.
    const freshCall = await newCallId(freshPersonId);
    const fresh = await inject('GET', `/dialer/calls/${freshCall}/brief`, a.token);
    expect(fresh.json().data.pastInteractions.threadCount).toBe(0);
    expect(fresh.json().data.pastInteractions.summary).toEqual([]);
    expect(fresh.json().data.talkingPoints.status).toBe('unavailable');
  }, 90_000);

  it('skip removes a call from the queue; log records a real outcome + logged_by (and no credit debit)', async () => {
    const skipId = await newCallId(freshPersonId); // freshPerson's open call (from the brief test)
    // freshPerson already has an open call from the brief test → idempotent returns it; skip it.
    const skip = await inject('POST', `/dialer/calls/${skipId}/skip`, a.token);
    expect(skip.statusCode).toBe(200);

    const personOpen = await admin
      .from('calls')
      .select('id')
      .eq('organization_id', a.orgId)
      .eq('lead_id', personId)
      .in('status', ['queued', 'scheduled'])
      .single();
    const log = await inject('POST', `/dialer/calls/${personOpen.data?.id}/log`, a.token, {
      outcome: 'connected',
      notes: 'Great call — booked a follow-up.',
    });
    expect(log.statusCode).toBe(200);
    expect(log.json().data).toMatchObject({
      status: 'logged',
      outcome: 'connected',
      logged_by: a.userId,
    });
    expect(log.json().data.called_at).toBeTruthy();

    // NO credit debit anywhere in the dialer flow.
    const ledger = await admin.from('credit_ledger').select('id').eq('organization_id', a.orgId);
    expect((ledger.data ?? []).length).toBe(0);
  }, 90_000);

  it('analytics: honest dialer counts (real once logged, org-isolated)', async () => {
    const res = await inject('GET', '/analytics/dialer', a.token);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.loggedCalls).toBeGreaterThanOrEqual(1);
    expect(d.byOutcome.connected).toBeGreaterThanOrEqual(1);
    expect(typeof d.connectRate).toBe('number'); // measurable now (>=1 attempted)
    // org B has no logged calls → honest-empty (no connectRate).
    const bRes = await inject('GET', '/analytics/dialer', b.token);
    expect(bRes.json().data.loggedCalls).toBe(0);
    expect(bRes.json().data.connectRate).toBeUndefined();
  }, 60_000);
});
