import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAndStoreDomainAuth } from '../agents/compliance/dns-verify.js';
import { runRetentionPurge } from '../agents/compliance/retention.js';
import { complianceRoute } from '../api/routes/compliance.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// Opt-in (RUN_DB_IT=1). Exercises the 4.12 compliance surface against a live DB. Proves: audit_logs is
// immutable (service-role append only) + org-scoped; REAL DNS verify (a reserved .invalid domain is a
// deterministic miss → never a false 'pass'); a fake-resolver pass path persists; and the retention
// purge is DRY-RUN-FIRST (reports + leaves rows until a deliberate flip, then really deletes).
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

describe.skipIf(!ready)('4.12 — compliance: audit log, DNS verify, dry-run retention', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const a: Acct = { orgId: '', userId: '', email: `comp-a+${stamp}@example.com`, token: '' };
  const b: Acct = { orgId: '', userId: '', email: `comp-b+${stamp}@example.com`, token: '' };

  async function mkOrgUser(acct: Acct, name: string) {
    const org = await admin.from('organizations').insert({ name }).select('id').single();
    if (org.error) throw org.error;
    acct.orgId = org.data.id as string;
    const pwd = `Test-${stamp}-pw!`;
    const created = await admin.auth.admin.createUser({
      email: acct.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    acct.userId = created.data.user.id;
    await admin
      .from('users')
      .insert({ id: acct.userId, organization_id: acct.orgId, email: acct.email, role: 'owner' });
    const signin = await anon.auth.signInWithPassword({ email: acct.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    acct.token = signin.data.session.access_token;
  }

  function app() {
    const f = Fastify();
    return f.register(complianceRoute).then(() => f);
  }

  beforeAll(async () => {
    await mkOrgUser(a, `comp-A-${stamp}`);
    await mkOrgUser(b, `comp-B-${stamp}`);
  }, 180_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    for (const u of [a, b]) if (u.userId) await admin.auth.admin.deleteUser(u.userId);
  });

  it('audit_logs is immutable (no client insert) + org-scoped read', async () => {
    // service-role append (the only legitimate writer)
    await admin.from('audit_logs').insert({
      organization_id: a.orgId,
      kind: 'sender_status_changed',
      args: { senderId: 'x', newStatus: 'paused' },
      source: 'user',
    });
    // a client CANNOT append (no insert policy) — proves the append-only/service-role discipline.
    const userDb = createUserClient(a.token);
    if (!userDb) throw new Error('user client unavailable');
    const forge = await userDb
      .from('audit_logs')
      .insert({ organization_id: a.orgId, kind: 'sender_status_changed' });
    expect(forge.error).toBeTruthy();

    const fA = await app();
    const resA = await fA.inject({
      method: 'GET',
      url: '/compliance/audit',
      headers: { authorization: `Bearer ${a.token}` },
    });
    await fA.close();
    const eventsA = (resA.json() as { data: { events: { kind: string }[] } }).data.events;
    expect(eventsA.some((e) => e.kind === 'sender_status_changed')).toBe(true);

    // org B never sees A's audit rows.
    const fB = await app();
    const resB = await fB.inject({
      method: 'GET',
      url: '/compliance/audit',
      headers: { authorization: `Bearer ${b.token}` },
    });
    await fB.close();
    const eventsB = (resB.json() as { data: { events: unknown[] } }).data.events;
    expect(eventsB.length).toBe(0);
  }, 60_000);

  it('POST /domains/:id/verify runs a REAL DNS lookup (a .invalid domain never falsely passes) + 404 cross-tenant', async () => {
    const dom = await admin
      .from('domains')
      .insert({ organization_id: a.orgId, domain: `nx-${stamp}.invalid` })
      .select('id')
      .single();
    if (dom.error) throw dom.error;

    const fA = await app();
    const res = await fA.inject({
      method: 'POST',
      url: `/domains/${dom.data.id}/verify`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    await fA.close();
    expect(res.statusCode).toBe(200);
    const row = (res.json() as { data: Record<string, string> }).data;
    // Reserved .invalid → never resolves → never a fabricated 'pass'; DKIM unknown (no selector).
    expect(['fail', 'unknown']).toContain(row.spf_status);
    expect(['fail', 'unknown']).toContain(row.dmarc_status);
    expect(row.dkim_status).toBe('unknown');
    expect(row.verified_at).toBeTruthy();

    // an audit row was written for the verification
    const audit = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', a.orgId)
      .eq('kind', 'domain_verified');
    expect((audit.count ?? 0) >= 1).toBe(true);

    // org B cannot verify A's domain (RLS hides it → 404 before any DNS work)
    const fB = await app();
    const resB = await fB.inject({
      method: 'POST',
      url: `/domains/${dom.data.id}/verify`,
      headers: { authorization: `Bearer ${b.token}` },
    });
    await fB.close();
    expect(resB.statusCode).toBe(404);
  }, 60_000);

  it('verifyAndStoreDomainAuth persists a pass from a fake resolver', async () => {
    const dom = await admin
      .from('domains')
      .insert({ organization_id: a.orgId, domain: `pass-${stamp}.example` })
      .select('id')
      .single();
    if (dom.error) throw dom.error;
    const fakePass = async (host: string) =>
      host.startsWith('_dmarc.') ? [['v=DMARC1; p=none']] : [['v=spf1 ~all']];
    const row = await verifyAndStoreDomainAuth(admin, dom.data.id as string, { resolve: fakePass });
    expect(row?.spf_status).toBe('pass');
    expect(row?.dmarc_status).toBe('pass');
  }, 60_000);

  it('retention is DRY-RUN-FIRST: reports + leaves rows, then a flip really deletes', async () => {
    // Seed a tracked domain + an OLD terminal visit (200 days > the 90-day window).
    const td = await admin
      .from('website_tracked_domains')
      .insert({ organization_id: a.orgId, domain: `wv-${stamp}.example`, site_key: `wv_${stamp}` })
      .select('id')
      .single();
    if (td.error) throw td.error;
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const visit = await admin
      .from('website_visits')
      .insert({
        organization_id: a.orgId,
        tracked_domain_id: td.data.id,
        anon_visitor_id: `anon-${stamp}`,
        event_id: `evt-${stamp}`,
        status: 'unresolved',
        origin: 'test_inject',
        created_at: old,
      })
      .select('id')
      .single();
    if (visit.error) throw visit.error;

    // A is retention_dry_run=true by default → REPORT, delete nothing.
    const dry = await runRetentionPurge(admin);
    expect(dry.websiteVisits >= 1).toBe(true);
    const stillThere = await admin
      .from('website_visits')
      .select('id')
      .eq('id', visit.data.id)
      .maybeSingle();
    expect(stillThere.data).not.toBeNull(); // NOT deleted in dry-run
    const reported = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', a.orgId)
      .eq('kind', 'retention_reported');
    expect((reported.count ?? 0) >= 1).toBe(true);

    // Deliberately flip A out of dry-run → the next run really deletes.
    await admin.from('organizations').update({ retention_dry_run: false }).eq('id', a.orgId);
    await runRetentionPurge(admin);
    const gone = await admin
      .from('website_visits')
      .select('id')
      .eq('id', visit.data.id)
      .maybeSingle();
    expect(gone.data).toBeNull(); // really deleted now
    const purged = await admin
      .from('audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', a.orgId)
      .eq('kind', 'retention_purged');
    expect((purged.count ?? 0) >= 1).toBe(true);
  }, 60_000);

  it('GET /compliance returns domains + retention policy + suppression', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'GET',
      url: '/compliance',
      headers: { authorization: `Bearer ${a.token}` },
    });
    await f.close();
    expect(res.statusCode).toBe(200);
    const data = (
      res.json() as {
        data: {
          retention: { dryRun: boolean; websiteVisitsDays: number };
          suppression: { total: number };
        };
      }
    ).data;
    // A was flipped to non-dry-run in the prior test.
    expect(data.retention.dryRun).toBe(false);
    expect(typeof data.retention.websiteVisitsDays).toBe('number');
    expect(typeof data.suppression.total).toBe('number');
  }, 60_000);
});
