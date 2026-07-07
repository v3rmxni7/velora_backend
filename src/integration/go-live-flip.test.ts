import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendingRoute } from '../api/routes/sending.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// S1 — productized go-live, the full safety matrix (RUN_DB_IT). Zero real email — this only flips the
// two org flags via the route's service-role CAS. readinessEnv is injected all-true so readiness
// depends solely on the per-org DB facts we control (warm mailbox / active sender / credits / postal
// address / staff-review). Every fence is asserted: owner-only, server-side org-name confirm,
// server-side readiness re-check (409, incl. the L1 postal-address tie), CAS from-not-live + idempotent
// already-live, org-from-JWT (no cross-tenant flip), no authenticated UPDATE, pause-live, re-go-live.
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

// All env prereqs green → readiness is decided only by the per-org DB facts the test sets up.
const ENV_GREEN = {
  smartleadConfigured: true,
  verifierConfigured: true,
  unsubscribeConfigured: true,
  webhookSecretSet: true,
};

describe.skipIf(!ready)('S1 — productized go-live (zero real email)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const orgAName = `golive-A-${stamp}`;
  let orgA = '';
  let orgB = '';
  const tok: Record<string, string> = {}; // role/name -> access token
  const uid: Record<string, string> = {};

  function appFor() {
    const f = Fastify();
    return f.register(sendingRoute, { readinessEnv: ENV_GREEN }).then(() => f);
  }
  async function addUser(orgId: string, tag: string, role: 'owner' | 'admin' | 'member') {
    const email = `golive-${tag}+${stamp}@example.com`;
    const created = await admin.auth.admin.createUser({
      email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    uid[tag] = created.data.user.id;
    const link = await admin
      .from('users')
      .insert({ id: created.data.user.id, organization_id: orgId, email, role });
    if (link.error) throw link.error;
    const signin = await anon.auth.signInWithPassword({ email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    tok[tag] = signin.data.session.access_token;
  }
  const flags = async (orgId: string) =>
    (
      await admin
        .from('organizations')
        .select('sending_enabled, sending_dry_run')
        .eq('id', orgId)
        .single()
    ).data as { sending_enabled: boolean; sending_dry_run: boolean };
  const goLive = async (
    f: Awaited<ReturnType<typeof appFor>>,
    token: string | undefined,
    confirm: string,
  ) =>
    f.inject({
      method: 'POST',
      url: '/sending/go-live',
      headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ confirm }),
    });

  beforeAll(async () => {
    // Org A — a fully go-live-READY org (warm mailbox, active sender, credits, postal address,
    // staff-reviewed), starting NOT live (defaults: enabled=false, dry_run=true).
    orgA = (await admin.from('organizations').insert({ name: orgAName }).select('id').single()).data
      ?.id as string;
    await admin.from('organizations').update({ go_live_reviewed: true }).eq('id', orgA);
    await admin
      .from('organizations')
      .update({ postal_address: 'Co, 1 St, City, IN' })
      .eq('id', orgA);
    const sender = (
      await admin
        .from('senders')
        .insert({ organization_id: orgA, display_name: 'S', status: 'active' })
        .select('id')
        .single()
    ).data?.id as string;
    await admin.from('mailboxes').insert({
      organization_id: orgA,
      email: `mb-${stamp}@x.com`,
      smartlead_email_account_id: `acct-${stamp}`,
      status: 'warm',
      sender_id: sender,
    });
    await admin.from('credit_ledger').insert({
      organization_id: orgA,
      delta: 100,
      reason: 'signup_grant',
      idempotency_key: `grant:${stamp}`,
    });
    await addUser(orgA, 'owner', 'owner');
    await addUser(orgA, 'admin', 'admin');
    await addUser(orgA, 'member', 'member');

    // Org B — a separate org (its own owner) to prove the flip is JWT-scoped, never cross-tenant.
    orgB = (
      await admin
        .from('organizations')
        .insert({ name: `golive-B-${stamp}` })
        .select('id')
        .single()
    ).data?.id as string;
    await addUser(orgB, 'ownerB', 'owner');
  }, 180_000);

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await admin.from('organizations').delete().eq('id', id);
    for (const k of Object.keys(uid)) if (uid[k]) await admin.auth.admin.deleteUser(uid[k]);
  });

  it('OWNER-ONLY — a member and an admin are both 403; flags unchanged', async () => {
    const f = await appFor();
    const m = await goLive(f, tok.member, orgAName);
    const a = await goLive(f, tok.admin, orgAName);
    await f.close();
    expect(m.statusCode).toBe(403);
    expect(a.statusCode).toBe(403);
    const fl = await flags(orgA);
    expect(fl.sending_enabled).toBe(false); // never flipped
    expect(fl.sending_dry_run).toBe(true);
  });

  it('WRONG PHRASE — owner with a mismatched confirm is 400; flags unchanged', async () => {
    const f = await appFor();
    const r = await goLive(f, tok.owner, 'not the org name');
    await f.close();
    expect(r.statusCode).toBe(400);
    const fl = await flags(orgA);
    expect(fl.sending_enabled).toBe(false);
  });

  it('READINESS RED (postal address unset, L1 tie) — 409, no flip', async () => {
    await admin.from('organizations').update({ postal_address: null }).eq('id', orgA);
    const f = await appFor();
    const r = await goLive(f, tok.owner, orgAName); // correct phrase, but a prereq is red
    await f.close();
    expect(r.statusCode).toBe(409);
    const body = r.json() as { data: { ready: boolean; items: { key: string; ok: boolean }[] } };
    expect(body.data.ready).toBe(false);
    expect(body.data.items.find((i) => i.key === 'postal_address')?.ok).toBe(false);
    const fl = await flags(orgA);
    expect(fl.sending_enabled).toBe(false); // still not live
    expect(fl.sending_dry_run).toBe(true);
    await admin
      .from('organizations')
      .update({ postal_address: 'Co, 1 St, City, IN' })
      .eq('id', orgA); // restore
  });

  it('HAPPY PATH — owner + correct phrase + all green flips false→live via CAS, audited', async () => {
    const f = await appFor();
    const r = await goLive(f, tok.owner, orgAName);
    await f.close();
    expect(r.statusCode).toBe(200);
    expect((r.json() as { data: { status: string } }).data.status).toBe('went_live');
    const fl = await flags(orgA);
    expect(fl.sending_enabled).toBe(true);
    expect(fl.sending_dry_run).toBe(false); // LIVE
    const audit = await admin
      .from('audit_logs')
      .select('kind')
      .eq('organization_id', orgA)
      .eq('kind', 'sending_go_live');
    expect((audit.data ?? []).length).toBe(1);
    // org B was never touched (the flip is JWT-scoped, not cross-tenant).
    const flB = await flags(orgB);
    expect(flB.sending_enabled).toBe(false);
    expect(flB.sending_dry_run).toBe(true);
  });

  it('IDEMPOTENT — running go-live again on a LIVE org is a no-op (already_live), no second flip', async () => {
    const f = await appFor();
    const r = await goLive(f, tok.owner, orgAName);
    await f.close();
    expect(r.statusCode).toBe(200);
    expect((r.json() as { data: { status: string } }).data.status).toBe('already_live');
    const audit = await admin
      .from('audit_logs')
      .select('id')
      .eq('organization_id', orgA)
      .eq('kind', 'sending_go_live');
    expect((audit.data ?? []).length).toBe(1); // still only ONE go-live audit row
  });

  it('NO AUTHENTICATED UPDATE — an owner cannot flip the flags directly (RLS 0 rows)', async () => {
    const db = createUserClient(tok.owner ?? '');
    if (!db) throw new Error('user client unavailable');
    const upd = await db
      .from('organizations')
      .update({ sending_enabled: false, sending_dry_run: true })
      .eq('id', orgA)
      .select('id');
    expect((upd.data ?? []).length).toBe(0); // no UPDATE policy → invisible to UPDATE
    const fl = await flags(orgA);
    expect(fl.sending_dry_run).toBe(false); // still LIVE — the direct write did nothing
  });

  it('PAUSE-LIVE — owner pauses (dry_run→true), audited; a member is 403', async () => {
    const f = await appFor();
    const memberPause = await f.inject({
      method: 'POST',
      url: '/sending/pause-live',
      headers: { authorization: `Bearer ${tok.member}` },
    });
    expect(memberPause.statusCode).toBe(403);
    const ownerPause = await f.inject({
      method: 'POST',
      url: '/sending/pause-live',
      headers: { authorization: `Bearer ${tok.owner}` },
    });
    await f.close();
    expect(ownerPause.statusCode).toBe(200);
    expect((ownerPause.json() as { data: { status: string } }).data.status).toBe('paused');
    const fl = await flags(orgA);
    expect(fl.sending_dry_run).toBe(true); // paused (enabled stays true)
    expect(fl.sending_enabled).toBe(true);
    const audit = await admin
      .from('audit_logs')
      .select('id')
      .eq('organization_id', orgA)
      .eq('kind', 'sending_paused');
    expect((audit.data ?? []).length).toBe(1);
  });

  it('RE-GO-LIVE — after a pause, owner + phrase flips dry_run→false again (CAS from dry_run=true)', async () => {
    const f = await appFor();
    const r = await goLive(f, tok.owner, orgAName);
    await f.close();
    expect(r.statusCode).toBe(200);
    expect((r.json() as { data: { status: string } }).data.status).toBe('went_live');
    const fl = await flags(orgA);
    expect(fl.sending_enabled).toBe(true);
    expect(fl.sending_dry_run).toBe(false); // live again
  });
});
