import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDraft } from '../agents/draft/generate.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// Opt-in (RUN_DB_IT=1) — hits the live DB + real Anthropic/OpenAI (a few cents).
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

describe.skipIf(!ready)('Slice 3 live — draft generation + tasks isolation', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a = { orgId: '', userId: '', email: `s3+${stamp}-a@example.com`, token: '' };
  const b = { orgId: '', userId: '', email: `s3+${stamp}-b@example.com`, token: '' };
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
      .insert({ name: `s3-${stamp}` })
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
        external_id: `s3rich:${stamp}`,
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
        external_id: `s3sparse:${stamp}`,
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

  it('PERSONALIZED happy path: grounded facts → verified draft (real Anthropic)', async () => {
    const p = await generateDraft({
      db: admin,
      organizationId: a.orgId,
      leadType: 'person',
      leadId: richLeadId,
    });
    expect(p.draftMode).toBe('personalized');
    expect(p.grounding.verification.ok).toBe(true);
    expect(p.grounding.facts.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(p.grounding.facts.map((f) => f.id));
    expect(p.grounding.usedFactIds.every((id) => ids.has(id))).toBe(true);
    expect(p.body.length).toBeGreaterThan(0);
  }, 60_000);

  it('TEMPLATE fallback: fact-starved lead → safe template, never a model claim', async () => {
    const p = await generateDraft(
      { db: admin, organizationId: a.orgId, leadType: 'person', leadId: sparseLeadId },
      { researcher: async () => ({ facts: [], allowedRefs: new Set<string>() }) },
    );
    expect(p.draftMode).toBe('template');
    expect(p.body.startsWith('Hi Pat,')).toBe(true);
    expect(/[%$]|\d{4,}/.test(p.body)).toBe(false);
  }, 30_000);

  it('IDEMPOTENT + ISOLATION: draft persists once; org B cannot read or approve', async () => {
    const dbA = userDb(a.token);
    const dbB = userDb(b.token);
    const dedupeKey = `draft:${a.orgId}:person:${richLeadId}:none`;
    const row = {
      organization_id: a.orgId,
      type: 'outbound_approval',
      status: 'pending',
      lead_type: 'person',
      lead_id: richLeadId,
      subject: 'S',
      body: 'B',
      draft_mode: 'template',
      confidence: 0,
      dedupe_key: dedupeKey,
    };
    const opts = { onConflict: 'organization_id,dedupe_key', ignoreDuplicates: true };
    expect((await dbA.from('tasks').upsert(row, opts).select('id')).error).toBeNull();
    expect((await dbA.from('tasks').upsert(row, opts).select('id')).error).toBeNull();

    const all = await dbA.from('tasks').select('id').eq('dedupe_key', dedupeKey);
    expect((all.data ?? []).length).toBe(1);
    const taskId = (all.data ?? [])[0]?.id as string;

    expect(((await dbB.from('tasks').select('id')).data ?? []).length).toBe(0);
    const evil = await dbB
      .from('tasks')
      .update({ status: 'approved' })
      .eq('id', taskId)
      .select('id');
    expect((evil.data ?? []).length).toBe(0);
    const after = await dbA.from('tasks').select('status').eq('id', taskId).maybeSingle();
    expect(after.data?.status).toBe('pending');
  }, 60_000);
});
