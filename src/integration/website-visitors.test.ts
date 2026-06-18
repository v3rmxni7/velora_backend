import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchCampaign, resolveAudience } from '../agents/sending/enroll.js';
import { processVisit, runVisitorSweep } from '../agents/website-visitors/ingest.js';
import { FakeResolver } from '../agents/website-visitors/resolver.js';
import { pixelRoute } from '../api/routes/pixel.js';
import { websiteVisitorsRoute } from '../api/routes/website-visitors.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB; the AUTHED domain routes via app.inject + real JWTs, the PUBLIC pixel
// beacon via an unauthenticated app.inject, the resolver core driven directly with a TEST-ONLY
// FakeResolver. NOTE: FakeResolver is a test fixture — in prod getResolver(env) returns null so the
// monitor sweep is a documented NO-OP; a green suite means the seam is correct, NOT that de-anon works.
// Proves Slice 4.6a: site_key minting + link (visitor-only 422); the public beacon records a raw
// anonymous visit (right org via site_key, no IP, url query-stripped, replay-collapsed); RLS forge-deny
// on the service-role-write tables; resolver-null sweep no-op; person → lead(source='website_visitors')
// + identification + pending enrollment + credit debit, idempotent, DRY-RUN (no message); two visits
// same anon → one enrollment; company → display-only (no enrollment); cross-tenant admin-path guard;
// paused campaign identifies-but-doesn't-enroll; resolveAudience connected-on-link + launch-before-link.
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

describe.skipIf(!ready)(
  'Slice 4.6a — website-visitor pixel + de-anon (DRY-RUN, resolver dormant)',
  () => {
    const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anon = createClient(SUPABASE_URL, ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const stamp = Date.now();
    const a: Acct = { orgId: '', userId: '', email: `wv-a+${stamp}@example.com`, token: '' };
    const b: Acct = { orgId: '', userId: '', email: `wv-b+${stamp}@example.com`, token: '' };

    let campaignActiveId = ''; // org A website_visitor campaign (active) — the enrollment target
    let coldCampaignId = ''; // org A cold campaign (for the not_visitor_campaign 422)
    let orgBCampaignId = ''; // org B website_visitor campaign (admin-path org-mismatch target)
    let domainId = '';
    let siteKey = '';

    async function makeAcct(o: Acct, tag: string) {
      const org = await admin
        .from('organizations')
        .insert({ name: `wv-${tag}-${stamp}` })
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
        .insert({ organization_id: org, name: `wv-${type}-${stamp}`, campaign_type: type, status })
        .select('id')
        .single();
      if (c.error) throw c.error;
      return c.data.id as string;
    }

    async function inject(method: 'GET' | 'POST', url: string, token?: string, payload?: unknown) {
      const app = Fastify();
      await app.register(websiteVisitorsRoute);
      await app.register(pixelRoute);
      const res = await app.inject({
        method,
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      await app.close();
      return res;
    }

    async function seedVisit(
      org: string,
      dom: string,
      anon_: string,
      event: string,
    ): Promise<string> {
      const v = await admin
        .from('website_visits')
        .insert({
          organization_id: org,
          tracked_domain_id: dom,
          anon_visitor_id: anon_,
          event_id: event,
          status: 'new',
          origin: 'test_inject',
        })
        .select('id')
        .single();
      if (v.error) throw v.error;
      return v.data.id as string;
    }

    const personLeadId = async (externalId: string): Promise<string | null> => {
      const r = await admin
        .from('people')
        .select('id')
        .eq('organization_id', a.orgId)
        .eq('provider', 'website_visitor')
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
      campaignActiveId = await makeCampaign(a.orgId, 'website_visitor', 'active');
      coldCampaignId = await makeCampaign(a.orgId, 'cold_outbound', 'draft');
      orgBCampaignId = await makeCampaign(b.orgId, 'website_visitor', 'active');
    }, 180_000);

    afterAll(async () => {
      if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
      if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
      if (a.userId) await admin.auth.admin.deleteUser(a.userId);
      if (b.userId) await admin.auth.admin.deleteUser(b.userId);
    });

    it('POST /website-visitors/domains mints a public site_key (201)', async () => {
      const res = await inject('POST', '/website-visitors/domains', a.token, {
        domain: 'Acme.com/pricing',
      });
      expect(res.statusCode).toBe(201);
      const d = res.json().data;
      expect(d.domain).toBe('acme.com'); // normalized (lowercased, path stripped)
      expect(typeof d.site_key).toBe('string');
      expect(d.site_key.startsWith('wv_')).toBe(true);
      domainId = d.id;
      siteKey = d.site_key;
    }, 60_000);

    it('link rejects a non-website_visitor campaign (422 not_visitor_campaign)', async () => {
      const res = await inject('POST', `/website-visitors/domains/${domainId}/link`, a.token, {
        campaignId: coldCampaignId,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: 'not_visitor_campaign' });
    }, 60_000);

    it('link a website_visitor campaign (200)', async () => {
      const res = await inject('POST', `/website-visitors/domains/${domainId}/link`, a.token, {
        campaignId: campaignActiveId,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.campaign_id).toBe(campaignActiveId);
    }, 60_000);

    it('public beacon records an anonymous visit for the right org (origin=beacon, no IP, url query-stripped)', async () => {
      const u = encodeURIComponent('https://acme.com/p?secret=tok&email=a@b.com');
      const r = encodeURIComponent('https://ref.com/x?q=1#frag');
      const res = await inject('GET', `/pixel/${siteKey}/collect.gif?vid=v1&e=e1&u=${u}&r=${r}`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/gif');

      const row = await admin
        .from('website_visits')
        .select('*')
        .eq('tracked_domain_id', domainId)
        .eq('event_id', 'e1')
        .single();
      expect(row.data?.organization_id).toBe(a.orgId);
      expect(row.data?.anon_visitor_id).toBe('v1');
      expect(row.data?.status).toBe('new');
      expect(row.data?.origin).toBe('beacon');
      expect(row.data?.page_url).toBe('https://acme.com/p'); // query + fragment stripped
      expect(row.data?.referrer).toBe('https://ref.com/x');
      expect(Object.keys(row.data ?? {})).not.toContain('ip'); // no IP persisted, by design
    }, 60_000);

    it('replay of the same event_id collapses to one visit row', async () => {
      const res = await inject(
        'GET',
        `/pixel/${siteKey}/collect.gif?vid=v1&e=e1&u=https://acme.com/p`,
      );
      expect(res.statusCode).toBe(200);
      const rows = await admin
        .from('website_visits')
        .select('id')
        .eq('tracked_domain_id', domainId)
        .eq('event_id', 'e1');
      expect((rows.data ?? []).length).toBe(1);
    }, 60_000);

    it('unknown site_key → GIF, writes nothing (fail-closed + opaque)', async () => {
      const res = await inject('GET', '/pixel/wv_does_not_exist/collect.gif?vid=v9&e=e9');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/gif');
      const rows = await admin.from('website_visits').select('id').eq('event_id', 'e9');
      expect((rows.data ?? []).length).toBe(0);
    }, 60_000);

    it('RLS: org B cannot read A’s visits, nor forge a visit/identification', async () => {
      const bClient = createClient(SUPABASE_URL, ANON, {
        global: { headers: { Authorization: `Bearer ${b.token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const read = await bClient.from('website_visits').select('id').eq('organization_id', a.orgId);
      expect((read.data ?? []).length).toBe(0);
      const forgeVisit = await bClient
        .from('website_visits')
        .insert({
          organization_id: b.orgId,
          tracked_domain_id: domainId,
          anon_visitor_id: 'x',
          event_id: 'x',
        })
        .select('id');
      expect(forgeVisit.error).toBeTruthy(); // SELECT-only → no insert policy → denied
      const forgeIdent = await bClient
        .from('website_visitor_identifications')
        .insert({
          organization_id: b.orgId,
          visit_id: domainId,
          tracked_domain_id: domainId,
          kind: 'person',
          provider: 'x',
        })
        .select('id');
      expect(forgeIdent.error).toBeTruthy();
    }, 60_000);

    it('resolver-null sweep is a no-op (visits stay new)', async () => {
      const sweep = await runVisitorSweep(admin, null);
      expect(sweep).toEqual({ swept: 0, identified: 0, enrolled: 0, unresolved: 0, failed: 0 });
      const stillNew = await admin
        .from('website_visits')
        .select('id')
        .eq('organization_id', a.orgId)
        .eq('status', 'new');
      expect((stillNew.data ?? []).length).toBeGreaterThanOrEqual(1);
    }, 60_000);

    it('FakeResolver person → lead + identification + pending enrollment + credit debit, DRY-RUN (no message)', async () => {
      const visitId = await seedVisit(a.orgId, domainId, 'person-1', 'pe1');
      const resolver = new FakeResolver({
        kind: 'person',
        confidence: 0.9,
        person: {
          externalId: 'rb2b-1',
          email: `wv-person+${stamp}@example.com`,
          fullName: 'Casey Visitor',
          title: 'VP',
        },
      });
      const out = await processVisit(admin, resolver, visitId);
      expect(out).toMatchObject({ outcome: 'identified', kind: 'person', enrolled: true });

      const v = await admin
        .from('website_visits')
        .select('status, resolved_at')
        .eq('id', visitId)
        .single();
      expect(v.data?.status).toBe('identified');
      expect(v.data?.resolved_at).toBeTruthy();

      const leadId = (await personLeadId('rb2b-1')) as string;
      expect(leadId).toBeTruthy();
      const person = await admin.from('people').select('source, email').eq('id', leadId).single();
      expect(person.data?.source).toBe('website_visitors');

      const ident = await admin
        .from('website_visitor_identifications')
        .select('kind, provider, person_id')
        .eq('visit_id', visitId)
        .single();
      expect(ident.data).toMatchObject({ kind: 'person', provider: 'fake', person_id: leadId });

      const enrs = await enrollmentsFor(campaignActiveId, leadId);
      expect(enrs.length).toBe(1);
      expect(enrs[0]?.status).toBe('pending');

      const cr = await admin
        .from('credit_ledger')
        .select('reason, reference')
        .eq('idempotency_key', `website_visitor:identify:${visitId}:person`);
      expect((cr.data ?? []).length).toBe(1);
      expect(cr.data?.[0]?.reason).toBe('website_visitor_identification');
      expect((cr.data?.[0]?.reference as { provider?: string })?.provider).toBe('fake');

      // DRY-RUN-honest: the enrollment is only PENDING — no message row was ever written.
      const msgs = await admin
        .from('messages')
        .select('id')
        .eq('enrollment_id', enrs[0]?.id as string);
      expect((msgs.data ?? []).length).toBe(0);
    }, 90_000);

    it('idempotent: re-processing the same visit is a no-op (skipped, one enrollment, no second debit)', async () => {
      const v = await admin
        .from('website_visits')
        .select('id')
        .eq('tracked_domain_id', domainId)
        .eq('event_id', 'pe1')
        .single();
      const visitId = v.data?.id as string;
      const resolver = new FakeResolver({
        kind: 'person',
        person: { externalId: 'rb2b-1', email: `wv-person+${stamp}@example.com` },
      });
      const again = await processVisit(admin, resolver, visitId);
      expect(again.outcome).toBe('skipped'); // status no longer 'new'
      const leadId = (await personLeadId('rb2b-1')) as string;
      expect((await enrollmentsFor(campaignActiveId, leadId)).length).toBe(1);
      const cr = await admin
        .from('credit_ledger')
        .select('id')
        .eq('idempotency_key', `website_visitor:identify:${visitId}:person`);
      expect((cr.data ?? []).length).toBe(1); // no double-charge
    }, 90_000);

    it('two visits, same anon/person → one enrollment (deterministic, never doubled)', async () => {
      const visitId = await seedVisit(a.orgId, domainId, 'person-1', 'pe2');
      const resolver = new FakeResolver({
        kind: 'person',
        person: { externalId: 'rb2b-1', email: `wv-person+${stamp}@example.com` },
      });
      const out = await processVisit(admin, resolver, visitId);
      expect(out.outcome).toBe('identified');
      const leadId = (await personLeadId('rb2b-1')) as string;
      expect((await enrollmentsFor(campaignActiveId, leadId)).length).toBe(1); // upsert ignoreDuplicates
    }, 90_000);

    it('company visit → companies row + identification, NO enrollment (display-only, no_email dead-end)', async () => {
      const visitId = await seedVisit(a.orgId, domainId, 'co-visitor', 'ce1');
      const resolver = new FakeResolver({
        kind: 'company',
        company: { externalId: 'co-1', name: 'Acme Inc', domain: 'acme.com', industry: 'SaaS' },
      });
      const out = await processVisit(admin, resolver, visitId);
      expect(out).toMatchObject({ outcome: 'identified', kind: 'company', enrolled: false });
      const co = await admin
        .from('companies')
        .select('id, source')
        .eq('organization_id', a.orgId)
        .eq('provider', 'website_visitor')
        .eq('external_id', 'co-1')
        .single();
      expect(co.data?.source).toBe('website_visitors');
      const ident = await admin
        .from('website_visitor_identifications')
        .select('kind, company_id')
        .eq('visit_id', visitId)
        .single();
      expect(ident.data).toMatchObject({ kind: 'company', company_id: co.data?.id });
      // No person, no enrollment from a company visit.
      const enrForCo = await admin
        .from('enrollments')
        .select('id')
        .eq('campaign_id', campaignActiveId)
        .eq('lead_id', co.data?.id as string);
      expect((enrForCo.data ?? []).length).toBe(0);
    }, 90_000);

    it('paused campaign → identifies but does NOT enroll (identification is independent of outreach)', async () => {
      await admin.from('campaigns').update({ status: 'paused' }).eq('id', campaignActiveId);
      const visitId = await seedVisit(a.orgId, domainId, 'paused-visitor', 'pae1');
      const resolver = new FakeResolver({
        kind: 'person',
        person: { externalId: 'rb2b-paused', email: `wv-paused+${stamp}@example.com` },
      });
      const out = await processVisit(admin, resolver, visitId);
      expect(out).toMatchObject({ outcome: 'identified', enrolled: false });
      const leadId = (await personLeadId('rb2b-paused')) as string;
      expect(leadId).toBeTruthy(); // identified (real)
      expect((await enrollmentsFor(campaignActiveId, leadId)).length).toBe(0); // but not enrolled
      await admin.from('campaigns').update({ status: 'active' }).eq('id', campaignActiveId);
    }, 90_000);

    it('cross-tenant admin-path guard: a domain linked to another org’s campaign → domain_org_mismatch, nothing enrolled into B', async () => {
      // Force the hostile state the link route's RLS would otherwise prevent.
      await admin
        .from('website_tracked_domains')
        .update({ campaign_id: orgBCampaignId })
        .eq('id', domainId);
      const visitId = await seedVisit(a.orgId, domainId, 'x-visitor', 'xe1');
      const resolver = new FakeResolver({
        kind: 'person',
        person: { externalId: 'rb2b-x', email: `wv-x+${stamp}@example.com` },
      });
      const out = await processVisit(admin, resolver, visitId);
      expect(out.outcome).toBe('failed');
      const v = await admin.from('website_visits').select('error').eq('id', visitId).single();
      expect(v.data?.error).toBe('domain_org_mismatch');
      const leak = await admin.from('enrollments').select('id').eq('campaign_id', orgBCampaignId);
      expect((leak.data ?? []).length).toBe(0);
      await admin
        .from('website_tracked_domains')
        .update({ campaign_id: campaignActiveId })
        .eq('id', domainId);
    }, 90_000);

    it('resolveAudience(website_visitor): connected:false→true on link; launch-before-link stays draft', async () => {
      const campId = await makeCampaign(a.orgId, 'website_visitor', 'draft');
      // No domain linked yet → not connected.
      const before = await resolveAudience(admin, {
        id: campId,
        organization_id: a.orgId,
        campaign_type: 'website_visitor',
      });
      expect(before).toMatchObject({ connected: false, source: 'website_visitors' });
      const launchBefore = await launchCampaign(admin, {
        id: campId,
        organization_id: a.orgId,
        campaign_type: 'website_visitor',
      });
      expect(launchBefore).toEqual({
        enrolled: 0,
        sourceConnected: false,
        source: 'website_visitors',
      });
      const draft = await admin.from('campaigns').select('status').eq('id', campId).single();
      expect(draft.data?.status).toBe('draft'); // stays draft — honest "install the pixel first"

      // Link a domain → connected, enrolls 0 at launch (honest), flips active.
      await admin.from('website_tracked_domains').insert({
        organization_id: a.orgId,
        domain: `linked-${stamp}.com`,
        site_key: `wv_link_${stamp}`,
        campaign_id: campId,
      });
      const after = await resolveAudience(admin, {
        id: campId,
        organization_id: a.orgId,
        campaign_type: 'website_visitor',
      });
      expect(after.connected).toBe(true);
      const launchAfter = await launchCampaign(admin, {
        id: campId,
        organization_id: a.orgId,
        campaign_type: 'website_visitor',
      });
      expect(launchAfter).toEqual({
        enrolled: 0,
        sourceConnected: true,
        source: 'website_visitors',
      });
    }, 90_000);

    it('GET /website-visitors/summary is honest: real visit counts, resolver not connected', async () => {
      const res = await inject('GET', '/website-visitors/summary', a.token);
      expect(res.statusCode).toBe(200);
      const d = res.json().data;
      expect(d.resolverConnected).toBe(false); // 🔌 no de-anon vendor → People/Companies render honest-empty
      expect(d.visitCounts.d30).toBeGreaterThanOrEqual(1); // real anonymous visits recorded
      expect(Array.isArray(d.domains)).toBe(true);
    }, 60_000);
  },
);
