import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authRoute } from '../api/routes/auth.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Exercises self-serve provisioning + accept-invite against a live DB. Proves:
// an authenticated-but-orgless user provisions a new org+owner+welcome-grant (idempotent); accept-invite
// joins the inviter's org only for the matching email, and rejects mismatch / already-in-org / bad /
// expired tokens.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

interface Acct {
  id: string;
  email: string;
  token: string;
}

describe.skipIf(!ready)('4.13 — self-serve provision + accept-invite', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;

  let orgA = ''; // the inviter org
  const owner: Acct = { id: '', email: `ap-owner+${stamp}@example.com`, token: '' };
  const fresh: Acct = { id: '', email: `ap-fresh+${stamp}@example.com`, token: '' }; // provisions a new org
  const invitee: Acct = { id: '', email: `ap-invitee+${stamp}@example.com`, token: '' };
  const stranger: Acct = { id: '', email: `ap-stranger+${stamp}@example.com`, token: '' };

  const validToken = `tok-valid-${stamp}`;
  const expiredToken = `tok-expired-${stamp}`;
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');

  // Create an auth user + sign in for a JWT. Does NOT create a public.users row (orgless).
  async function mkAuthUser(a: Acct) {
    const created = await admin.auth.admin.createUser({
      email: a.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    a.id = created.data.user.id;
    const signin = await anon.auth.signInWithPassword({ email: a.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    a.token = signin.data.session.access_token;
  }

  function app() {
    const f = Fastify();
    return f.register(authRoute).then(() => f);
  }
  const post = (url: string, token: string | null, body?: unknown) =>
    app().then((f) =>
      f
        .inject({
          method: 'POST',
          url,
          headers: token ? { authorization: `Bearer ${token}` } : {},
          ...(body ? { payload: body } : {}),
        })
        .finally(() => f.close()),
    );

  beforeAll(async () => {
    await Promise.all([
      mkAuthUser(owner),
      mkAuthUser(fresh),
      mkAuthUser(invitee),
      mkAuthUser(stranger),
    ]);

    // Org A with the owner as its member (the inviter).
    const org = await admin
      .from('organizations')
      .insert({ name: `ap-A-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    orgA = org.data.id as string;
    await admin
      .from('users')
      .insert({ id: owner.id, organization_id: orgA, email: owner.email, role: 'owner' });

    // A valid pending invite for the invitee + an EXPIRED one for the stranger.
    await admin.from('team_invitations').insert([
      {
        organization_id: orgA,
        email: invitee.email,
        role: 'member',
        token_hash: sha(validToken),
        status: 'pending',
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        invited_by: owner.id,
      },
      {
        organization_id: orgA,
        email: stranger.email,
        role: 'member',
        token_hash: sha(expiredToken),
        status: 'pending',
        expires_at: new Date(Date.now() - 86_400_000).toISOString(),
        invited_by: owner.id,
      },
    ]);
  }, 180_000);

  afterAll(async () => {
    // Delete any orgs these accounts ended up in, then the auth users.
    const orgs = new Set<string>([orgA]);
    for (const a of [fresh, invitee]) {
      const u = await admin.from('users').select('organization_id').eq('id', a.id).maybeSingle();
      if (u.data?.organization_id) orgs.add(u.data.organization_id as string);
    }
    for (const o of orgs) if (o) await admin.from('organizations').delete().eq('id', o);
    for (const a of [owner, fresh, invitee, stranger])
      if (a.id) await admin.auth.admin.deleteUser(a.id);
  });

  it('provision creates an org+owner+welcome-grant and is idempotent', async () => {
    const first = await post('/auth/provision', fresh.token);
    expect(first.statusCode).toBe(201);
    const d1 = (
      first.json() as { data: { organizationId: string; role: string; provisioned: boolean } }
    ).data;
    expect(d1.provisioned).toBe(true);
    expect(d1.role).toBe('owner');
    const newOrg = d1.organizationId;

    // owner row + welcome grant exist
    const u = await admin.from('users').select('role').eq('id', fresh.id).single();
    expect(u.data?.role).toBe('owner');
    const grant = await admin
      .from('credit_ledger')
      .select('delta')
      .eq('organization_id', newOrg)
      .eq('reason', 'signup_grant');
    expect((grant.data ?? []).length).toBe(1);
    expect(Number(grant.data?.[0]?.delta)).toBe(env.SIGNUP_GRANT_CREDITS);

    // idempotent: second call returns the same org, provisioned:false, no second org or grant.
    const second = await post('/auth/provision', fresh.token);
    expect(second.statusCode).toBe(200);
    const d2 = (second.json() as { data: { organizationId: string; provisioned: boolean } }).data;
    expect(d2.organizationId).toBe(newOrg);
    expect(d2.provisioned).toBe(false);
    const orgCount = await admin
      .from('credit_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', newOrg)
      .eq('reason', 'signup_grant');
    expect(orgCount.count ?? 0).toBe(1);
  }, 60_000);

  it('rejects an unauthenticated provision (401)', async () => {
    const res = await post('/auth/provision', null);
    expect(res.statusCode).toBe(401);
  });

  it('email-mismatch cannot accept someone else’s invite (403)', async () => {
    const res = await post('/auth/accept-invite', stranger.token, { token: validToken });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('email_mismatch');
  }, 60_000);

  it('accept-invite joins the inviter’s org with the invite role + marks it accepted', async () => {
    const res = await post('/auth/accept-invite', invitee.token, { token: validToken });
    expect(res.statusCode).toBe(200);
    const d = (res.json() as { data: { organizationId: string; role: string } }).data;
    expect(d.organizationId).toBe(orgA);
    expect(d.role).toBe('member');

    const u = await admin
      .from('users')
      .select('organization_id, role')
      .eq('id', invitee.id)
      .single();
    expect(u.data?.organization_id).toBe(orgA);
    expect(u.data?.role).toBe('member');
    const inv = await admin
      .from('team_invitations')
      .select('status')
      .eq('organization_id', orgA)
      .eq('email', invitee.email)
      .single();
    expect(inv.data?.status).toBe('accepted');
  }, 60_000);

  it('a user already in an org cannot accept again (409)', async () => {
    const res = await post('/auth/accept-invite', invitee.token, { token: validToken });
    expect(res.statusCode).toBe(409);
  }, 60_000);

  it('a bad token is 404; an expired invite is 410', async () => {
    const bad = await post('/auth/accept-invite', stranger.token, { token: `nope-${stamp}` });
    expect(bad.statusCode).toBe(404);
    const expired = await post('/auth/accept-invite', stranger.token, { token: expiredToken });
    expect(expired.statusCode).toBe(410);
    // stranger is still orgless after both rejections
    const u = await admin.from('users').select('id').eq('id', stranger.id).maybeSingle();
    expect(u.data).toBeNull();
  }, 60_000);
});
