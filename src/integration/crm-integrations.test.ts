import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCrmSync } from '../agents/crm/sync.js';
import { launchCampaign, resolveAudience } from '../agents/sending/enroll.js';
import { integrationsRoute } from '../api/routes/integrations.js';
import { env } from '../config/env.js';
import { FakeCrmClient } from '../integrations/crm/client.js';

// Opt-in (RUN_DB_IT=1). Live DB; authed routes via app.inject + real JWTs; the sync core driven directly
// with a TEST-ONLY FakeCrmClient. NOTE: FakeCrmClient is a test fixture — in prod getCrmClient(env,...)
// returns null so the crm-sync-monitor is a documented NO-OP; a green suite means the seam is correct,
// NOT that a CRM is connected. Proves Slice 4.7a: connect honest 'not_configured' (no creds); the
// TOKEN LOCK (authenticated clients can't read integration_secrets; integrations has no token column;
// GET /integrations omits oauth); cross-tenant RLS; the 'crm' source widen; contact → person lead
// (source='crm') + DRY-RUN pending enrollment (no message), idempotent re-sync; email-less skipped;
// cross-tenant admin-path guard; paused syncs-but-doesn't-enroll; failure never echoes the token;
// resolveAudience(warm/cross_sell) connected-on-link + launch-before-link draft; not_crm_campaign 422.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const TOKEN_SENTINEL = 'SECRET-CRM-TOKEN-do-not-leak';

interface Acct {
  orgId: string;
  userId: string;
  email: string;
  token: string;
}

describe.skipIf(!ready)('Slice 4.7a — CRM connect + sync (DRY-RUN, provider dormant)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const a: Acct = { orgId: '', userId: '', email: `crm-a+${stamp}@example.com`, token: '' };
  const b: Acct = { orgId: '', userId: '', email: `crm-b+${stamp}@example.com`, token: '' };

  let warmActiveId = ''; // org A warm_outbound (active) — the link/enroll target
  let coldId = ''; // org A cold_outbound (for the not_crm_campaign 422)
  let orgBWarmId = ''; // org B warm_outbound (admin-path org-mismatch target)

  async function makeAcct(o: Acct, tag: string) {
    const org = await admin
      .from('organizations')
      .insert({ name: `crm-${tag}-${stamp}` })
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

  async function makeCampaign(org: string, type: string, status: string): Promise<string> {
    const c = await admin
      .from('campaigns')
      .insert({ organization_id: org, name: `crm-${type}-${stamp}`, campaign_type: type, status })
      .select('id')
      .single();
    if (c.error) throw c.error;
    return c.data.id as string;
  }

  async function seedIntegration(
    org: string,
    provider: string,
    campaignId: string | null,
    status = 'connected',
  ): Promise<string> {
    const i = await admin
      .from('integrations')
      .upsert(
        { organization_id: org, kind: 'crm', provider, status, campaign_id: campaignId },
        { onConflict: 'organization_id,kind,provider' },
      )
      .select('id')
      .single();
    if (i.error) throw i.error;
    const s = await admin
      .from('integration_secrets')
      .upsert(
        {
          integration_id: i.data.id,
          organization_id: org,
          oauth: { access_token: TOKEN_SENTINEL },
        },
        { onConflict: 'integration_id' },
      )
      .select('id');
    if (s.error) throw s.error;
    return i.data.id as string;
  }

  async function inject(method: 'GET' | 'POST', url: string, token: string, payload?: unknown) {
    const app = Fastify();
    await app.register(integrationsRoute);
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    await app.close();
    return res;
  }

  const personLeadId = async (provider: string, externalId: string): Promise<string | null> => {
    const r = await admin
      .from('people')
      .select('id')
      .eq('organization_id', a.orgId)
      .eq('provider', provider)
      .eq('external_id', externalId)
      .maybeSingle();
    if (r.error) throw r.error;
    return (r.data?.id as string) ?? null;
  };
  const enrollmentsFor = async (campaignId: string, leadId: string) => {
    const r = await admin
      .from('enrollments')
      .select('id, status')
      .eq('campaign_id', campaignId)
      .eq('lead_id', leadId);
    if (r.error) throw r.error;
    return r.data ?? [];
  };

  beforeAll(async () => {
    await makeAcct(a, 'a');
    await makeAcct(b, 'b');
    warmActiveId = await makeCampaign(a.orgId, 'warm_outbound', 'active');
    coldId = await makeCampaign(a.orgId, 'cold_outbound', 'draft');
    orgBWarmId = await makeCampaign(b.orgId, 'warm_outbound', 'active');
  }, 180_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('connect with no creds → 422 not_configured (no row, no fake)', async () => {
    const res = await inject('POST', '/integrations/crm/hubspot/connect', a.token);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'not_configured' });
    const rows = await admin.from('integrations').select('id').eq('organization_id', a.orgId);
    expect((rows.data ?? []).length).toBe(0); // nothing written
  }, 60_000);

  it('GET /integrations is empty + no provider configurable (no creds)', async () => {
    const res = await inject('GET', '/integrations', a.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ integrations: [], configurableProviders: [] });
  }, 60_000);

  it('TOKEN LOCK: integration_secrets is unreadable to clients; integrations has no token column', async () => {
    await seedIntegration(a.orgId, 'hubspot', warmActiveId);
    const aClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: `Bearer ${a.token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // integration_secrets: RLS-enabled, NO policy → deny-all to authenticated (0 rows, no token).
    const secrets = await aClient
      .from('integration_secrets')
      .select('*')
      .eq('organization_id', a.orgId);
    expect((secrets.data ?? []).length).toBe(0);
    // integrations: readable metadata, but there is NO oauth column to leak.
    const intg = await aClient
      .from('integrations')
      .select('*')
      .eq('organization_id', a.orgId)
      .single();
    expect(Object.keys(intg.data ?? {})).not.toContain('oauth');
    expect(JSON.stringify(intg.data ?? {})).not.toContain(TOKEN_SENTINEL);
    // GET /integrations route also never returns a token.
    const res = await inject('GET', '/integrations', a.token);
    expect(JSON.stringify(res.json())).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(res.json())).not.toContain('oauth');
  }, 60_000);

  it('cross-tenant: org B cannot read org A’s integrations', async () => {
    const bClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: `Bearer ${b.token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const read = await bClient.from('integrations').select('id').eq('organization_id', a.orgId);
    expect((read.data ?? []).length).toBe(0);
    const res = await inject('GET', '/integrations', b.token);
    expect(res.json().data.integrations.length).toBe(0); // B sees only its own (none)
  }, 60_000);

  it("the 'crm' source value is accepted (the widen worked)", async () => {
    const p = await admin
      .from('people')
      .insert({
        organization_id: a.orgId,
        provider: 'crm:test',
        external_id: `widen-${stamp}`,
        email: `w+${stamp}@x.com`,
        source: 'crm',
      })
      .select('id');
    expect(p.error).toBeNull();
  }, 60_000);

  it('FakeCrmClient sync → person lead (source=crm) + pending enrollment, DRY-RUN (no message)', async () => {
    // hubspot integration is linked to warmActiveId (seeded in the TOKEN LOCK test).
    const getClient = (provider: string) =>
      provider === 'hubspot'
        ? new FakeCrmClient([
            {
              externalId: 'c1',
              email: `crm-c1+${stamp}@example.com`,
              fullName: 'Casey One',
              title: 'VP',
            },
          ])
        : new FakeCrmClient([]);
    const res = await runCrmSync(admin, getClient);
    expect(res.enrolled).toBeGreaterThanOrEqual(1);

    const leadId = (await personLeadId('crm:hubspot', 'c1')) as string;
    expect(leadId).toBeTruthy();
    const person = await admin.from('people').select('source').eq('id', leadId).single();
    expect(person.data?.source).toBe('crm');

    const enrs = await enrollmentsFor(warmActiveId, leadId);
    expect(enrs.length).toBe(1);
    expect(enrs[0]?.status).toBe('pending');

    // DRY-RUN-honest: only a PENDING enrollment — no message row was ever written.
    const msgs = await admin
      .from('messages')
      .select('id')
      .eq('enrollment_id', enrs[0]?.id as string);
    expect((msgs.data ?? []).length).toBe(0);
  }, 90_000);

  it('idempotent re-sync: the same contact yields one enrollment', async () => {
    const getClient = (provider: string) =>
      provider === 'hubspot'
        ? new FakeCrmClient([{ externalId: 'c1', email: `crm-c1+${stamp}@example.com` }])
        : new FakeCrmClient([]);
    await runCrmSync(admin, getClient);
    const leadId = (await personLeadId('crm:hubspot', 'c1')) as string;
    expect((await enrollmentsFor(warmActiveId, leadId)).length).toBe(1);
  }, 90_000);

  it('email-less contact is skipped (display-only — no lead, no enrollment)', async () => {
    const getClient = (provider: string) =>
      provider === 'hubspot'
        ? new FakeCrmClient([{ externalId: 'c2-noemail', email: null, companyName: 'Acme Co' }])
        : new FakeCrmClient([]);
    const res = await runCrmSync(admin, getClient);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(await personLeadId('crm:hubspot', 'c2-noemail')).toBeNull(); // not upserted
  }, 90_000);

  it('cross-tenant admin-path guard: a CRM linked to another org’s campaign → no enrollment into it', async () => {
    // A salesforce integration for org A, forced to link org B's campaign (the hostile state).
    await seedIntegration(a.orgId, 'salesforce', orgBWarmId);
    const getClient = (provider: string) =>
      provider === 'salesforce'
        ? new FakeCrmClient([{ externalId: 'cx', email: `crm-cx+${stamp}@example.com` }])
        : new FakeCrmClient([]);
    await runCrmSync(admin, getClient);
    const leak = await admin.from('enrollments').select('id').eq('campaign_id', orgBWarmId);
    expect((leak.data ?? []).length).toBe(0); // org_mismatch → nothing enrolled into B
  }, 90_000);

  it('paused campaign: syncs the lead but does NOT enroll', async () => {
    await admin.from('campaigns').update({ status: 'paused' }).eq('id', warmActiveId);
    const getClient = (provider: string) =>
      provider === 'hubspot'
        ? new FakeCrmClient([{ externalId: 'c3-paused', email: `crm-c3+${stamp}@example.com` }])
        : new FakeCrmClient([]);
    await runCrmSync(admin, getClient);
    const leadId = (await personLeadId('crm:hubspot', 'c3-paused')) as string;
    expect(leadId).toBeTruthy(); // synced (lead upserted)
    expect((await enrollmentsFor(warmActiveId, leadId)).length).toBe(0); // but not enrolled
    await admin.from('campaigns').update({ status: 'active' }).eq('id', warmActiveId);
  }, 90_000);

  it('a sync failure records an integration error WITHOUT echoing the token', async () => {
    const thrower: { provider: string; listContacts: () => Promise<never> } = {
      provider: 'hubspot',
      listContacts: async () => {
        throw new Error('vendor 500');
      },
    };
    const getClient = (provider: string) =>
      provider === 'hubspot' ? (thrower as unknown as FakeCrmClient) : new FakeCrmClient([]);
    const res = await runCrmSync(admin, getClient);
    expect(res.failed).toBeGreaterThanOrEqual(1);
    const intg = await admin
      .from('integrations')
      .select('status, error')
      .eq('organization_id', a.orgId)
      .eq('provider', 'hubspot')
      .single();
    expect(intg.data?.status).toBe('error');
    expect(intg.data?.error ?? '').not.toContain(TOKEN_SENTINEL); // never echo the token
    // restore for later tests
    await admin
      .from('integrations')
      .update({ status: 'connected', error: null })
      .eq('organization_id', a.orgId)
      .eq('provider', 'hubspot');
  }, 90_000);

  it('resolveAudience(warm_outbound): false→true on link; launch-before-link stays draft', async () => {
    const w = await makeCampaign(a.orgId, 'warm_outbound', 'draft');
    const before = await resolveAudience(admin, {
      id: w,
      organization_id: a.orgId,
      campaign_type: 'warm_outbound',
    });
    expect(before).toMatchObject({ connected: false, source: 'crm' });
    const launchBefore = await launchCampaign(admin, {
      id: w,
      organization_id: a.orgId,
      campaign_type: 'warm_outbound',
    });
    expect(launchBefore).toEqual({ enrolled: 0, sourceConnected: false, source: 'crm' });
    const draft = await admin.from('campaigns').select('status').eq('id', w).single();
    expect(draft.data?.status).toBe('draft'); // honest: install/connect first

    // Link the connected hubspot integration to w via the authed route, then connected:true.
    const link = await inject('POST', '/integrations/crm/hubspot/link', a.token, { campaignId: w });
    expect(link.statusCode).toBe(200);
    const after = await resolveAudience(admin, {
      id: w,
      organization_id: a.orgId,
      campaign_type: 'warm_outbound',
    });
    expect(after.connected).toBe(true);
    const launchAfter = await launchCampaign(admin, {
      id: w,
      organization_id: a.orgId,
      campaign_type: 'warm_outbound',
    });
    expect(launchAfter).toEqual({ enrolled: 0, sourceConnected: true, source: 'crm' });
  }, 90_000);

  it('link rejects a non-CRM campaign (422 not_crm_campaign)', async () => {
    const res = await inject('POST', '/integrations/crm/hubspot/link', a.token, {
      campaignId: coldId,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'not_crm_campaign' });
  }, 60_000);
});
