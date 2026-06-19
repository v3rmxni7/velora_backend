import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copilotRoute } from '../api/routes/copilot.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Exercises the 4.11 agentic confirm executor against a live DB — WITHOUT the
// LLM. Proposed actions are inserted directly (exactly as the route persists them after the planner
// proposes), then the deterministic confirm/cancel routes are driven via app.inject + real JWTs.
// Proves: confirm executes the real work + is role-gated + idempotent + cross-tenant-safe, and a
// launch can't fabricate an audience or cause a send.
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
interface ActionRow {
  id: string;
  status: string;
  result: { sourceConnected?: boolean; enrolled?: number } | null;
}

describe.skipIf(!ready)('4.11 — copilot agentic confirm executor (propose → confirm)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const owner: Acct = { orgId: '', userId: '', email: `ca-owner+${stamp}@example.com`, token: '' };
  const member: Acct = {
    orgId: '',
    userId: '',
    email: `ca-member+${stamp}@example.com`,
    token: '',
  };
  const orgB: Acct = { orgId: '', userId: '', email: `ca-b+${stamp}@example.com`, token: '' };
  let threadA = '';

  async function mkUser(a: Acct, orgId: string, role: 'owner' | 'member') {
    a.orgId = orgId;
    const pwd = `Test-${stamp}-pw!`;
    const created = await admin.auth.admin.createUser({
      email: a.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    a.userId = created.data.user.id;
    await admin
      .from('users')
      .insert({ id: a.userId, organization_id: orgId, email: a.email, role });
    const signin = await anon.auth.signInWithPassword({ email: a.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    a.token = signin.data.session.access_token;
  }

  async function proposeAction(kind: string, actionClass: string, args: unknown): Promise<string> {
    const row = await admin
      .from('copilot_actions')
      .insert({
        organization_id: owner.orgId,
        thread_id: threadA,
        user_id: owner.userId,
        kind,
        action_class: actionClass,
        title: `${kind} (test)`,
        args,
        status: 'proposed',
      })
      .select('id')
      .single();
    if (row.error) throw row.error;
    return row.data.id as string;
  }

  function buildApp() {
    const app = Fastify();
    app.register(copilotRoute);
    return app;
  }
  const confirm = (id: string, token: string) =>
    buildApp().then((app) =>
      app
        .inject({
          method: 'POST',
          url: `/copilot/actions/${id}/confirm`,
          headers: { authorization: `Bearer ${token}` },
        })
        .finally(() => app.close()),
    );

  beforeAll(async () => {
    const oa = await admin
      .from('organizations')
      .insert({ name: `ca-A-${stamp}` })
      .select('id')
      .single();
    if (oa.error) throw oa.error;
    await mkUser(owner, oa.data.id as string, 'owner');
    await mkUser(member, oa.data.id as string, 'member');

    const ob = await admin
      .from('organizations')
      .insert({ name: `ca-B-${stamp}` })
      .select('id')
      .single();
    if (ob.error) throw ob.error;
    await mkUser(orgB, ob.data.id as string, 'owner');

    const th = await admin
      .from('copilot_threads')
      .insert({ organization_id: owner.orgId, user_id: owner.userId, title: 'actions' })
      .select('id')
      .single();
    if (th.error) throw th.error;
    threadA = th.data.id as string;
  }, 180_000);

  afterAll(async () => {
    if (owner.orgId) await admin.from('organizations').delete().eq('id', owner.orgId);
    if (orgB.orgId) await admin.from('organizations').delete().eq('id', orgB.orgId);
    for (const u of [owner, member, orgB])
      if (u.userId) await admin.auth.admin.deleteUser(u.userId);
  });

  it('confirm pause_campaign executes the real pause (active → paused)', async () => {
    const camp = await admin
      .from('campaigns')
      .insert({
        organization_id: owner.orgId,
        name: `pc-${stamp}`,
        campaign_type: 'cold_outbound',
        status: 'active',
      })
      .select('id')
      .single();
    if (camp.error) throw camp.error;
    const actionId = await proposeAction('pause_campaign', 'safe', { campaignId: camp.data.id });

    const res = await confirm(actionId, owner.token);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: ActionRow }).data.status).toBe('confirmed');

    const after = await admin.from('campaigns').select('status').eq('id', camp.data.id).single();
    expect(after.data?.status).toBe('paused');
  }, 60_000);

  it('confirm launch_campaign keeps a no-source campaign as draft, enrolls 0, sends nothing', async () => {
    // intent_signals with no subscription → source not connected → stays draft, enrolls nothing.
    const camp = await admin
      .from('campaigns')
      .insert({
        organization_id: owner.orgId,
        name: `lc-${stamp}`,
        campaign_type: 'intent_signals',
        status: 'draft',
      })
      .select('id')
      .single();
    if (camp.error) throw camp.error;
    const actionId = await proposeAction('launch_campaign', 'destructive', {
      campaignId: camp.data.id,
    });

    const res = await confirm(actionId, owner.token);
    expect(res.statusCode).toBe(200);
    const data = (res.json() as { data: ActionRow }).data;
    expect(data.status).toBe('confirmed');
    expect(data.result?.sourceConnected).toBe(false);
    expect(data.result?.enrolled).toBe(0);

    const after = await admin.from('campaigns').select('status').eq('id', camp.data.id).single();
    expect(after.data?.status).toBe('draft'); // never fabricates an audience / never flips to active

    const enr = await admin
      .from('enrollments')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', camp.data.id);
    expect(enr.count ?? 0).toBe(0);
  }, 60_000);

  it('confirm is role-gated — a member gets 403 and the action stays proposed', async () => {
    const actionId = await proposeAction('pause_autonomy', 'safe', {});
    const res = await confirm(actionId, member.token);
    expect(res.statusCode).toBe(403);
    const row = await admin.from('copilot_actions').select('status').eq('id', actionId).single();
    expect(row.data?.status).toBe('proposed');
  }, 60_000);

  it('re-confirming an already-confirmed action is a 409 (no double-execute)', async () => {
    await admin.from('organizations').update({ autonomy_enabled: true }).eq('id', owner.orgId);
    const actionId = await proposeAction('pause_autonomy', 'safe', {});

    const first = await confirm(actionId, owner.token);
    expect(first.statusCode).toBe(200);
    const org1 = await admin
      .from('organizations')
      .select('autonomy_enabled')
      .eq('id', owner.orgId)
      .single();
    expect(org1.data?.autonomy_enabled).toBe(false);

    const second = await confirm(actionId, owner.token);
    expect(second.statusCode).toBe(409);
  }, 60_000);

  it('cancel resolves a proposed action without executing it', async () => {
    const camp = await admin
      .from('campaigns')
      .insert({
        organization_id: owner.orgId,
        name: `cn-${stamp}`,
        campaign_type: 'cold_outbound',
        status: 'active',
      })
      .select('id')
      .single();
    if (camp.error) throw camp.error;
    const actionId = await proposeAction('pause_campaign', 'safe', { campaignId: camp.data.id });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/copilot/actions/${actionId}/cancel`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: ActionRow }).data.status).toBe('cancelled');

    const after = await admin.from('campaigns').select('status').eq('id', camp.data.id).single();
    expect(after.data?.status).toBe('active'); // NOT executed
  }, 60_000);

  it('cross-tenant confirm is blocked (org B cannot confirm org A’s action → 404)', async () => {
    const actionId = await proposeAction('pause_autonomy', 'safe', {});
    const res = await confirm(actionId, orgB.token);
    expect(res.statusCode).toBe(404); // RLS hides A's row from B
    const row = await admin.from('copilot_actions').select('status').eq('id', actionId).single();
    expect(row.data?.status).toBe('proposed');
  }, 60_000);
});
