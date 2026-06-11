import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCopilotTurn } from '../agents/copilot/run.js';
import { suggestActions } from '../agents/copilot/tools.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// Opt-in (RUN_DB_IT=1) — hits the live DB + real Anthropic (copilot/icp) and OpenAI (icp has no
// embed, but the env gate matches the other live tests). A few cents.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY &&
  !!env.ANTHROPIC_API_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('Slice 4 live — copilot tools + tenant isolation', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a = { orgId: '', userId: '', email: `s4+${stamp}-a@example.com`, token: '' };
  const b = { orgId: '', userId: '', email: `s4+${stamp}-b@example.com`, token: '' };
  let threadAId = '';

  function userDb(token: string) {
    const db = createUserClient(token);
    if (!db) throw new Error('user-scoped client unavailable');
    return db;
  }

  async function makeOrgUser(o: { orgId: string; userId: string; email: string; token: string }) {
    const org = await admin
      .from('organizations')
      .insert({ name: `s4-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    o.orgId = org.data.id as string;
    const created = await admin.auth.admin.createUser({
      email: o.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser failed');
    o.userId = created.data.user.id;
    const link = await admin
      .from('users')
      .insert({ id: o.userId, organization_id: o.orgId, email: o.email, role: 'owner' });
    if (link.error) throw link.error;
    const signin = await anon.auth.signInWithPassword({ email: o.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin failed');
    o.token = signin.data.session.access_token;
  }

  beforeAll(async () => {
    await makeOrgUser(a);
    await makeOrgUser(b);
    // Org A: KB (for suggest_icp) + a couple of leads (for list_leads).
    await admin.from('coaching_points').insert({
      organization_id: a.orgId,
      content:
        'We sell developer-productivity tooling to SaaS engineering teams. Value-first tone.',
    });
    await admin.from('proof_items').insert({
      organization_id: a.orgId,
      category: 'customer',
      title: 'Nimbus Labs',
      body: 'Helped a 200-person SaaS engineering org cut CI time 40%.',
    });
    await admin.from('people').insert([
      {
        organization_id: a.orgId,
        provider: 'seed',
        external_id: `s4a:${stamp}:1`,
        full_name: 'Jordan Lee',
        title: 'CTO',
        company_name: 'Nimbus Labs',
        source: 'find_leads',
      },
      {
        organization_id: a.orgId,
        provider: 'seed',
        external_id: `s4a:${stamp}:2`,
        full_name: 'Robin Park',
        title: 'VP Engineering',
        company_name: 'Cirrus',
        source: 'find_leads',
      },
    ]);
    // Org B: one lead, distinct, to prove tool-level isolation.
    await admin.from('people').insert({
      organization_id: b.orgId,
      provider: 'seed',
      external_id: `s4b:${stamp}:1`,
      full_name: 'Org B Person',
      title: 'CEO',
      company_name: 'OtherCo',
      source: 'find_leads',
    });
    const thread = await userDb(a.token)
      .from('copilot_threads')
      .insert({ organization_id: a.orgId, user_id: a.userId, title: 'demo' })
      .select('id')
      .single();
    if (thread.error) throw thread.error;
    threadAId = thread.data.id as string;
  }, 120_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('KB-backed tool ACTUALLY executes: suggest_icp returns real personas + persists tool_calls', async () => {
    const dbA = userDb(a.token);
    const turn = await runCopilotTurn({
      db: dbA,
      organizationId: a.orgId,
      history: [],
      userMessage: 'Suggest ICP personas from my knowledge base.',
    });
    // The tool ran (not just the model answering from its prompt).
    expect(turn.toolCall?.name).toBe('suggest_icp');
    const result = turn.toolCall?.result as { suggestions?: unknown[] };
    expect(Array.isArray(result.suggestions)).toBe(true);
    expect((result.suggestions ?? []).length).toBeGreaterThan(0);
    expect(turn.replyText.length).toBeGreaterThan(0);

    // Persist the turn the way the route does, and confirm tool_calls is stored for audit.
    const ins = await dbA
      .from('copilot_messages')
      .insert([
        {
          organization_id: a.orgId,
          thread_id: threadAId,
          role: 'user',
          content: 'Suggest ICP personas from my knowledge base.',
        },
        {
          organization_id: a.orgId,
          thread_id: threadAId,
          role: 'assistant',
          content: turn.replyText,
          tool_calls: turn.toolCall,
        },
      ])
      .select('role, tool_calls');
    expect(ins.error).toBeNull();
    const assistant = (ins.data ?? []).find((r) => r.role === 'assistant');
    expect((assistant?.tool_calls as { name?: string })?.name).toBe('suggest_icp');
  }, 60_000);

  it('TOOL-LEVEL cross-tenant isolation: list_leads in an org-B session returns ONLY org-B rows', async () => {
    const dbB = userDb(b.token);
    const turn = await runCopilotTurn({
      db: dbB,
      organizationId: b.orgId,
      history: [],
      userMessage: 'List my people leads.',
    });
    expect(turn.toolCall?.name).toBe('list_leads');
    const rows = (turn.toolCall?.result as { rows?: { full_name?: string }[] }).rows ?? [];
    // Structural proof: org B sees its own row, never org A's leads.
    const names = rows.map((r) => r.full_name);
    expect(names).toContain('Org B Person');
    expect(names).not.toContain('Jordan Lee');
    expect(names).not.toContain('Robin Park');
  }, 60_000);

  it('org B cannot read org A threads or messages (RLS)', async () => {
    const dbB = userDb(b.token);
    const threads = await dbB.from('copilot_threads').select('id').eq('id', threadAId);
    expect((threads.data ?? []).length).toBe(0);
    const msgs = await dbB.from('copilot_messages').select('id').eq('thread_id', threadAId);
    expect((msgs.data ?? []).length).toBe(0);
  }, 30_000);

  it('suggested-actions returns a sensible nudge for the seeded state (KB + leads, no lists)', async () => {
    // Org A has KB + leads but no lists yet → "Organize leads into a list".
    const dbA = userDb(a.token);
    const count = async (t: string) =>
      (await dbA.from(t).select('*', { count: 'exact', head: true })).count ?? 0;
    const actions = suggestActions({
      kbDocuments: await count('kb_documents'),
      coachingPoints: await count('coaching_points'),
      proofItems: await count('proof_items'),
      leads:
        (await count('people')) + (await count('companies')) + (await count('local_businesses')),
      lists: await count('lists'),
      tasks: await count('tasks'),
    });
    expect(actions[0]?.label).toBe('Organize leads into a list');
  }, 30_000);
});
