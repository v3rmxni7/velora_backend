import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchCampaign, resolveAudience } from '../agents/sending/enroll.js';
import { processSignalEvent, runSignalSweep } from '../agents/signals/ingest.js';
import { campaignsRoute } from '../api/routes/campaigns.js';
import { signalsRoute } from '../api/routes/signals.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB, routes via app.inject + real JWTs; the service-role admin client
// seeds signal_events the way a real feed (🔌 deferred) or the test inject would. Proves Slice 4.5a:
// the real live/coming-soon catalog split, live-only + intent-only subscribe, an intent campaign
// creatable with no list, honest 0-enroll launch, event→person→pending-enrollment ingest (NO real
// send), idempotency + deterministic variant stability, the 4.1a pause gate (event stays pending),
// cross-tenant RLS, and the admin-path org-mismatch guard. No LLM, no Smartlead, zero real email.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const LIVE_KEYS = [
  'funding_announcement',
  'new_leadership_hire',
  'first_hire_in_department',
  'first_hire_in_role',
];

interface Acct {
  orgId: string;
  userId: string;
  email: string;
  token: string;
}

describe.skipIf(!ready)('Slice 4.5a — signals catalog + event-driven enrollment (DRY-RUN)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const a: Acct = { orgId: '', userId: '', email: `sig-a+${stamp}@example.com`, token: '' };
  const b: Acct = { orgId: '', userId: '', email: `sig-b+${stamp}@example.com`, token: '' };

  // Catalog def ids (looked up in beforeAll).
  let fundingDefId = ''; // live (funding)
  let leadershipDefId = ''; // live (hiring) — used for the admin-path org-mismatch test
  let comingSoonDefId = ''; // coming_soon (webhook)

  let campaignId = ''; // org A's intent_signals campaign (the subscription target)
  let coldCampaignId = ''; // org A's cold campaign (to prove the not_intent_campaign 422)
  let orgBCampaignId = ''; // org B's campaign (admin-path org-mismatch target)

  async function makeAcct(o: Acct, tag: string) {
    const org = await admin
      .from('organizations')
      .insert({ name: `sig-${tag}-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    o.orgId = org.data.id as string;
    const pwd = `Test-${stamp}-pw!`;
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
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    o.token = signin.data.session.access_token;
  }

  async function inject(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    token: string,
    payload?: unknown,
  ) {
    const app = Fastify();
    await app.register(campaignsRoute);
    await app.register(signalsRoute);
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    await app.close();
    return res;
  }

  async function defId(key: string): Promise<string> {
    const r = await admin.from('signal_definitions').select('id').eq('key', key).single();
    if (r.error) throw r.error;
    return r.data.id as string;
  }

  // Seed a signal_event the way a real feed / test inject would (service-role; origin marks it test).
  async function seedEvent(
    org: string,
    signalDefinitionId: string,
    externalId: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const ev = await admin
      .from('signal_events')
      .insert({
        organization_id: org,
        signal_definition_id: signalDefinitionId,
        payload: { externalId, email: `${externalId}+${stamp}@example.com`, ...extra },
        status: 'pending',
        origin: 'test_inject',
      })
      .select('id')
      .single();
    if (ev.error) throw ev.error;
    return ev.data.id as string;
  }

  async function leadId(provider: string, externalId: string): Promise<string | null> {
    const r = await admin
      .from('people')
      .select('id')
      .eq('organization_id', a.orgId)
      .eq('provider', provider)
      .eq('external_id', externalId)
      .maybeSingle();
    if (r.error) throw r.error;
    return (r.data?.id as string) ?? null;
  }

  async function enrollmentsForLead(lead: string) {
    const r = await admin
      .from('enrollments')
      .select('id, status, variant_id')
      .eq('campaign_id', campaignId)
      .eq('lead_id', lead);
    if (r.error) throw r.error;
    return r.data ?? [];
  }

  beforeAll(async () => {
    await makeAcct(a, 'a');
    await makeAcct(b, 'b');
    fundingDefId = await defId('funding_announcement');
    leadershipDefId = await defId('new_leadership_hire');
    comingSoonDefId = await defId('webhook');

    // org A cold campaign (for the not_intent_campaign 422). admin insert bypasses the create route.
    const cold = await admin
      .from('campaigns')
      .insert({
        organization_id: a.orgId,
        name: 'sig-cold',
        campaign_type: 'cold_outbound',
        status: 'draft',
      })
      .select('id')
      .single();
    if (cold.error) throw cold.error;
    coldCampaignId = cold.data.id as string;

    // org B campaign (admin-path org-mismatch target).
    const ob = await admin
      .from('campaigns')
      .insert({
        organization_id: b.orgId,
        name: 'sig-orgB',
        campaign_type: 'intent_signals',
        status: 'active',
      })
      .select('id')
      .single();
    if (ob.error) throw ob.error;
    orgBCampaignId = ob.data.id as string;
  }, 180_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('GET /signals returns the SPEC §3.9 catalog (12 rows) with exactly the 4 live signals', async () => {
    const res = await inject('GET', '/signals', a.token);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{
      key: string;
      status: string;
      subscribed: boolean;
      campaignId: string | null;
    }>;
    expect(rows.length).toBe(12); // 4 live + 8 coming-soon (SPEC §3.9)
    const live = rows
      .filter((r) => r.status === 'live')
      .map((r) => r.key)
      .sort();
    expect(live).toEqual([...LIVE_KEYS].sort());
    // Nothing subscribed yet → honest-empty state for the whole catalog.
    expect(rows.every((r) => r.subscribed === false && r.campaignId === null)).toBe(true);
  }, 60_000);

  it('creates an intent_signals campaign with NO list (201) and authors variants', async () => {
    const create = await inject('POST', '/campaigns', a.token, {
      name: 'sig-intent',
      campaignType: 'intent_signals',
    });
    expect(create.statusCode).toBe(201);
    campaignId = create.json().data.id as string;
    expect(create.json().data.campaign_type).toBe('intent_signals');
    expect(create.json().data.list_id).toBeNull();

    const vars = await inject('PUT', `/campaigns/${campaignId}/variants`, a.token, {
      variants: [
        { label: 'A', angle: 'lead with the funding milestone' },
        { label: 'B', angle: 'lead with a peer reference' },
      ],
    });
    expect(vars.statusCode).toBe(200);
  }, 60_000);

  it('subscribe rejects a coming-soon signal (422 signal_not_live)', async () => {
    const res = await inject('POST', `/signals/${comingSoonDefId}/subscribe`, a.token, {
      campaignId,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'signal_not_live' });
  }, 60_000);

  it('subscribe rejects a non-intent campaign (422 not_intent_campaign)', async () => {
    const res = await inject('POST', `/signals/${fundingDefId}/subscribe`, a.token, {
      campaignId: coldCampaignId,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'not_intent_campaign' });
  }, 60_000);

  it('subscribe a LIVE signal → catalog shows Active; launch is honest 0-enroll/connected', async () => {
    const sub = await inject('POST', `/signals/${fundingDefId}/subscribe`, a.token, { campaignId });
    expect(sub.statusCode).toBe(200);

    const res = await inject('GET', '/signals', a.token);
    const rows = res.json().data as Array<{
      id: string;
      subscribed: boolean;
      campaignId: string | null;
    }>;
    const funding = rows.find((r) => r.id === fundingDefId);
    expect(funding?.subscribed).toBe(true);
    expect(funding?.campaignId).toBe(campaignId);

    // resolveAudience: connected via the live subscription, but NO fabricated members.
    const audience = await resolveAudience(admin, {
      id: campaignId,
      organization_id: a.orgId,
      campaign_type: 'intent_signals',
    });
    expect(audience).toMatchObject({ connected: true, source: 'signals' });
    expect(audience.members.length).toBe(0);

    // launch flips active + enrolls nothing (leads arrive as events fire) — honest, never a fake audience.
    const launch = await launchCampaign(admin, {
      id: campaignId,
      organization_id: a.orgId,
      campaign_type: 'intent_signals',
    });
    expect(launch).toEqual({ enrolled: 0, sourceConnected: true, source: 'signals' });
    const camp = await admin.from('campaigns').select('status').eq('id', campaignId).single();
    expect(camp.data?.status).toBe('active');
  }, 90_000);

  it('processSignalEvent enrolls a person lead (pending, source=signals) with NO real send', async () => {
    const eventId = await seedEvent(a.orgId, fundingDefId, 'contact-1', {
      full_name: 'Casey Funder',
      title: 'CFO',
      company_name: 'Acme',
    });
    const out = await processSignalEvent(admin, eventId);
    expect(out.outcome).toBe('enrolled');

    const ev = await admin
      .from('signal_events')
      .select('status, processed_at, origin')
      .eq('id', eventId)
      .single();
    expect(ev.data?.status).toBe('processed');
    expect(ev.data?.processed_at).toBeTruthy();
    expect(ev.data?.origin).toBe('test_inject'); // persisted test marker

    const lead = await leadId('signal:funding', 'funding_announcement:contact-1');
    expect(lead).toBeTruthy();
    const person = await admin
      .from('people')
      .select('source')
      .eq('id', lead as string)
      .single();
    expect(person.data?.source).toBe('signals'); // traceable provenance

    const enrs = await enrollmentsForLead(lead as string);
    expect(enrs.length).toBe(1);
    expect(enrs[0]?.status).toBe('pending');
    expect(enrs[0]?.variant_id).toBeTruthy(); // 4.4 cohort assigned on the async path

    // DRY-RUN-honest: enrollment is only PENDING — no message row was ever written.
    const msgs = await admin
      .from('messages')
      .select('id')
      .eq('enrollment_id', enrs[0]?.id as string);
    expect((msgs.data ?? []).length).toBe(0);
  }, 90_000);

  it('idempotent: re-processing the same event is a no-op (one enrollment, stays processed)', async () => {
    const lead = (await leadId('signal:funding', 'funding_announcement:contact-1')) as string;
    const before = await enrollmentsForLead(lead);
    const variantBefore = before[0]?.variant_id;

    // Find the original (already-processed) event for this contact and re-run it.
    const ev = await admin
      .from('signal_events')
      .select('id')
      .eq('organization_id', a.orgId)
      .eq('signal_definition_id', fundingDefId)
      .eq('status', 'processed')
      .limit(1)
      .single();
    if (ev.error || !ev.data) throw ev.error ?? new Error('no processed event');
    const again = await processSignalEvent(admin, ev.data.id as string);
    expect(again.outcome).toBe('skipped'); // status CAS: no longer pending

    // A NEW event for the SAME contact also yields no second enrollment, and the SAME variant cohort.
    const dupEventId = await seedEvent(a.orgId, fundingDefId, 'contact-1');
    const dup = await processSignalEvent(admin, dupEventId);
    expect(dup.outcome).toBe('enrolled'); // ran, but the enrollment upsert ignores the duplicate
    const after = await enrollmentsForLead(lead);
    expect(after.length).toBe(1);
    expect(after[0]?.variant_id).toBe(variantBefore); // deterministic — never reshuffled
  }, 90_000);

  it('4.1a — a paused campaign leaves the event PENDING; resume + sweep enrolls exactly once', async () => {
    await admin.from('campaigns').update({ status: 'paused' }).eq('id', campaignId);
    const eventId = await seedEvent(a.orgId, fundingDefId, 'contact-2');
    const paused = await processSignalEvent(admin, eventId);
    expect(paused.outcome).toBe('campaign_paused');
    const evPaused = await admin.from('signal_events').select('status').eq('id', eventId).single();
    expect(evPaused.data?.status).toBe('pending'); // left for a later sweep — never a lost event
    expect(await leadId('signal:funding', 'funding_announcement:contact-2')).toBeNull();

    // Resume + sweep → the previously-blocked event now enrolls.
    await admin.from('campaigns').update({ status: 'active' }).eq('id', campaignId);
    const sweep = await runSignalSweep(admin);
    expect(sweep.swept).toBeGreaterThanOrEqual(1);
    const evDone = await admin.from('signal_events').select('status').eq('id', eventId).single();
    expect(evDone.data?.status).toBe('processed');
    const lead = (await leadId('signal:funding', 'funding_announcement:contact-2')) as string;
    expect(lead).toBeTruthy();
    expect((await enrollmentsForLead(lead)).length).toBe(1);

    // A second sweep is idempotent — nothing new to process.
    const sweep2 = await runSignalSweep(admin);
    expect((await enrollmentsForLead(lead)).length).toBe(1);
    expect(sweep2.enrolled).toBe(0);
  }, 120_000);

  it('cross-tenant: org B cannot read org A subscriptions/events; catalog shows B unsubscribed', async () => {
    const bClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: `Bearer ${b.token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const subs = await bClient
      .from('signal_subscriptions')
      .select('id')
      .eq('campaign_id', campaignId);
    expect((subs.data ?? []).length).toBe(0);
    const evs = await bClient.from('signal_events').select('id').eq('organization_id', a.orgId);
    expect((evs.data ?? []).length).toBe(0);

    // org B's own catalog read: same 12 defs, but nothing subscribed (subscriptions are org-scoped).
    const res = await inject('GET', '/signals', b.token);
    const rows = res.json().data as Array<{ subscribed: boolean }>;
    expect(rows.length).toBe(12);
    expect(rows.every((r) => r.subscribed === false)).toBe(true);
  }, 60_000);

  it('read-only posture: an authenticated user cannot forge signal_events or catalog rows', async () => {
    // The "no fabricated intent data" guarantee rests on these tables being write-locked to users:
    // signal_events has only a SELECT policy (writes are service-role: monitor / future feed), and
    // signal_definitions is a read-only shared catalog. Both inserts must be denied by RLS.
    const aClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: `Bearer ${a.token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const forgeEvent = await aClient
      .from('signal_events')
      .insert({
        organization_id: a.orgId,
        signal_definition_id: fundingDefId,
        payload: { externalId: 'forged', email: `forged+${stamp}@example.com` },
      })
      .select('id');
    expect(forgeEvent.error).toBeTruthy(); // RLS: no INSERT policy → denied
    expect(forgeEvent.data).toBeNull();

    const forgeDef = await aClient
      .from('signal_definitions')
      .insert({ key: `forged-${stamp}`, category: 'other', name: 'Forged', status: 'live' })
      .select('id');
    expect(forgeDef.error).toBeTruthy(); // read-only shared catalog → denied
    expect(forgeDef.data).toBeNull();
  }, 60_000);

  it('admin-path guard: an event whose subscription campaign belongs to another org is marked failed', async () => {
    // Defense-in-depth: the service-role monitor bypasses RLS, so a (corrupted/hostile) subscription
    // pointing org A's signal at org B's campaign must NOT enroll into org B. Inserted via admin to
    // simulate exactly the state the route's RLS would otherwise prevent.
    const sub = await admin
      .from('signal_subscriptions')
      .insert({
        organization_id: a.orgId,
        signal_definition_id: leadershipDefId,
        campaign_id: orgBCampaignId,
        active: true,
      })
      .select('id')
      .single();
    if (sub.error) throw sub.error;

    const eventId = await seedEvent(a.orgId, leadershipDefId, 'cross-1');
    const out = await processSignalEvent(admin, eventId);
    expect(out.outcome).toBe('failed');
    const ev = await admin.from('signal_events').select('status, error').eq('id', eventId).single();
    expect(ev.data?.status).toBe('failed');
    expect(ev.data?.error).toBe('campaign_org_mismatch');
    // Nothing enrolled into org B's campaign.
    const leak = await admin.from('enrollments').select('id').eq('campaign_id', orgBCampaignId);
    expect((leak.data ?? []).length).toBe(0);
  }, 90_000);
});
