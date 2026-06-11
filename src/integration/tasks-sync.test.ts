import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDraftGeneration } from '../agents/draft/task.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// Opt-in (RUN_DB_IT=1) — hits the live DB + real Anthropic/OpenAI (a few cents). Exercises the
// shared runDraftGeneration() that BOTH the Inngest job and POST /tasks/generate-sync call.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY &&
  !!env.ANTHROPIC_API_KEY &&
  !!env.OPENAI_API_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('BE-1 live — synchronous draft generation', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a = { orgId: '', userId: '', email: `sync+${stamp}-a@example.com`, token: '' };
  const b = { orgId: '', userId: '', email: `sync+${stamp}-b@example.com`, token: '' };
  let richLeadId = '';
  let sparseLeadId = '';

  function userDb(token: string) {
    const db = createUserClient(token);
    if (!db) throw new Error('user-scoped client unavailable');
    return db;
  }

  async function makeOrgUser(o: { orgId: string; userId: string; email: string; token: string }) {
    const org = await admin
      .from('organizations')
      .insert({ name: `sync-${stamp}` })
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
    await admin.from('coaching_points').insert({
      organization_id: a.orgId,
      content: 'Friendly, concise, value-first tone. One clear CTA. No hype.',
    });
    await admin.from('proof_items').insert({
      organization_id: a.orgId,
      category: 'customer',
      title: 'Acme',
      body: 'Helped a SaaS engineering team ship faster.',
    });
    const rich = await admin
      .from('people')
      .insert({
        organization_id: a.orgId,
        provider: 'seed',
        external_id: `sync-rich:${stamp}`,
        first_name: 'Jordan',
        last_name: 'Lee',
        full_name: 'Jordan Lee',
        title: 'CTO',
        seniority: 'c_level',
        department: 'engineering',
        company_name: 'Nimbus Labs',
        location: 'San Francisco',
        country: 'US',
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (rich.error) throw rich.error;
    richLeadId = rich.data.id as string;
    const sparse = await admin
      .from('people')
      .insert({
        organization_id: a.orgId,
        provider: 'seed',
        external_id: `sync-sparse:${stamp}`,
        first_name: 'Pat',
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (sparse.error) throw sparse.error;
    sparseLeadId = sparse.data.id as string;
  }, 120_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('PERSONALIZED: returns a real grounded task (draft_mode=personalized, >=2 facts)', async () => {
    const { task } = await runDraftGeneration({
      db: userDb(a.token),
      organizationId: a.orgId,
      leadType: 'person',
      leadId: richLeadId,
    });
    expect(task).toBeTruthy();
    expect(task?.id).toBeTruthy();
    expect(task?.status).toBe('pending');
    expect(task?.draft_mode).toBe('personalized');
    const grounding = task?.grounding as { facts?: unknown[] } | null;
    expect((grounding?.facts ?? []).length).toBeGreaterThanOrEqual(2);
    expect(String(task?.body ?? '').length).toBeGreaterThan(0);
  }, 60_000);

  it('TEMPLATE fallback: fact-starved lead → safe template (no LLM via researcher stub)', async () => {
    const { task } = await runDraftGeneration(
      { db: userDb(a.token), organizationId: a.orgId, leadType: 'person', leadId: sparseLeadId },
      { researcher: async () => ({ facts: [], allowedRefs: new Set<string>() }) },
    );
    expect(task?.draft_mode).toBe('template');
    expect(task?.status).toBe('pending');
  }, 30_000);

  it('CROSS-TENANT: org B cannot generate against org A’s lead (404) and sees no tasks', async () => {
    const dbB = userDb(b.token);
    await expect(
      runDraftGeneration({
        db: dbB,
        organizationId: b.orgId,
        leadType: 'person',
        leadId: richLeadId, // org A's lead
      }),
    ).rejects.toThrow();
    const seen = await dbB.from('tasks').select('id');
    expect((seen.data ?? []).length).toBe(0);
  }, 30_000);
});
