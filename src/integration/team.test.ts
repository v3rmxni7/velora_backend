import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamRoute } from '../api/routes/team.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// Opt-in (RUN_DB_IT=1). Live DB; routes via app.inject + real JWTs. Proves Slice 4.8a team management:
// the new co-member SELECT RLS (org B can't read org A; a member CAN read co-members); honest-shell
// invite (pending row + a one-time token, no email claimed, token/hash never returned); role + remove
// gated to owner with safety rails (self-change/self-remove blocked, escalation 403); cross-tenant
// manage blocked; and the DB last-owner guard. No real email, no SMTP.
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

describe.skipIf(!ready)('Slice 4.8a — team management (RLS + roles + invite honest-shell)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a: Acct = { orgId: '', userId: '', email: `team-a+${stamp}@example.com`, token: '' }; // owner of A
  const a2: Acct = { orgId: '', userId: '', email: `team-a2+${stamp}@example.com`, token: '' }; // member of A
  const b: Acct = { orgId: '', userId: '', email: `team-b+${stamp}@example.com`, token: '' }; // owner of B

  async function makeOrg(o: Acct, role: string) {
    const org = await admin
      .from('organizations')
      .insert({ name: `team-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    o.orgId = org.data.id as string;
    await addUser(o, o.orgId, role);
  }
  async function addUser(o: Acct, orgId: string, role: string) {
    o.orgId = orgId;
    const created = await admin.auth.admin.createUser({
      email: o.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    o.userId = created.data.user.id;
    const link = await admin
      .from('users')
      .insert({ id: o.userId, organization_id: orgId, email: o.email, role });
    if (link.error) throw link.error;
    const signin = await anon.auth.signInWithPassword({ email: o.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    o.token = signin.data.session.access_token;
  }

  async function inject(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token: string,
    payload?: unknown,
  ) {
    const app = Fastify();
    await app.register(teamRoute);
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    await app.close();
    return res;
  }

  beforeAll(async () => {
    await makeOrg(a, 'owner');
    await addUser(a2, a.orgId, 'member');
    await makeOrg(b, 'owner');
  }, 180_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    for (const u of [a, a2, b]) if (u.userId) await admin.auth.admin.deleteUser(u.userId);
  });

  it('co-member read: an org A member lists BOTH members; org B sees only itself', async () => {
    const resA = await inject('GET', '/team/members', a.token);
    expect(resA.statusCode).toBe(200);
    const emailsA = (resA.json().data.members as { email: string }[]).map((m) => m.email).sort();
    expect(emailsA).toEqual([a.email, a2.email].sort());

    const resB = await inject('GET', '/team/members', b.token);
    expect((resB.json().data.members as unknown[]).length).toBe(1);
  }, 60_000);

  it('cross-tenant RLS: org B’s user-client cannot read org A’s users', async () => {
    const bDb = createUserClient(b.token);
    if (!bDb) throw new Error('no client');
    const leak = await bDb.from('users').select('id').eq('organization_id', a.orgId);
    expect((leak.data ?? []).length).toBe(0);
  }, 60_000);

  it('invite (owner) is honest-shell: pending row + one-time token, never claims an email, token not leaked', async () => {
    const res = await inject('POST', '/team/invitations', a.token, {
      email: `invitee+${stamp}@example.com`,
      role: 'member',
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().data.token).toBe('string'); // raw token returned ONCE to the inviter
    const list = await inject('GET', '/team/invitations', a.token);
    const invs = list.json().data.invitations as Record<string, unknown>[];
    expect(invs.length).toBe(1);
    expect(invs[0]).not.toHaveProperty('token');
    expect(invs[0]).not.toHaveProperty('token_hash');
  }, 60_000);

  it('invite rejects an existing member (409 already_member)', async () => {
    const res = await inject('POST', '/team/invitations', a.token, {
      email: a2.email,
      role: 'member',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'already_member' });
  }, 60_000);

  it('a member cannot invite (403)', async () => {
    const res = await inject('POST', '/team/invitations', a2.token, {
      email: `nope+${stamp}@example.com`,
      role: 'member',
    });
    expect(res.statusCode).toBe(403);
  }, 60_000);

  it('owner can change a member’s role; a non-owner cannot (403)', async () => {
    const promote = await inject('PATCH', `/team/members/${a2.userId}`, a.token, { role: 'admin' });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().data.role).toBe('admin');
    // a2 is now admin — still cannot change roles (owner-only).
    const a2signin = await anon.auth.signInWithPassword({ email: a2.email, password: pwd });
    const a2token = a2signin.data.session?.access_token as string;
    const blocked = await inject('PATCH', `/team/members/${a.userId}`, a2token, { role: 'member' });
    expect(blocked.statusCode).toBe(403);
  }, 60_000);

  it('safety rails: owner cannot change own role or remove self (409)', async () => {
    const role = await inject('PATCH', `/team/members/${a.userId}`, a.token, { role: 'member' });
    expect(role.statusCode).toBe(409);
    expect(role.json()).toMatchObject({ error: 'cannot_change_own_role' });
    const rm = await inject('DELETE', `/team/members/${a.userId}`, a.token);
    expect(rm.statusCode).toBe(409);
    expect(rm.json()).toMatchObject({ error: 'cannot_remove_self' });
  }, 60_000);

  it('cross-tenant: owner of A cannot manage a user in org B (404)', async () => {
    const res = await inject('PATCH', `/team/members/${b.userId}`, a.token, { role: 'member' });
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it('DB last-owner guard: demoting the sole owner is rejected at the database', async () => {
    // Direct admin write (bypasses the route's self-guard) → the constraint trigger must raise.
    const demote = await admin.from('users').update({ role: 'member' }).eq('id', a.userId);
    expect(demote.error).toBeTruthy();
    expect(demote.error?.message ?? '').toContain('org_must_retain_owner');
  }, 60_000);

  it('owner removes a member (deletes the membership row, not a new org)', async () => {
    const rm = await inject('DELETE', `/team/members/${a2.userId}`, a.token);
    expect(rm.statusCode).toBe(200);
    const after = await admin.from('users').select('id').eq('id', a2.userId).maybeSingle();
    expect(after.data).toBeNull(); // membership row gone
  }, 60_000);
});
