import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestDocument } from '../agents/kb/ingest.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';

// Opt-in only (RUN_DB_IT=1) — this hits the live hosted DB and spends a few
// cents (one Firecrawl scrape + one OpenAI embed). Skipped in normal test runs.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY &&
  !!env.OPENAI_API_KEY &&
  !!env.FIRECRAWL_API_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('Slice 1 live — KB ingest + tenant isolation', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const queryVec = new Array(1536).fill(0.1) as number[];
  const a = { orgId: '', userId: '', email: `kbtest+${stamp}-a@example.com`, token: '' };
  const b = { orgId: '', userId: '', email: `kbtest+${stamp}-b@example.com`, token: '' };
  let ingestedChunks = 0;

  function userDb(token: string) {
    const db = createUserClient(token);
    if (!db) throw new Error('user-scoped client unavailable');
    return db;
  }

  async function makeOrgUser(o: { orgId: string; userId: string; email: string; token: string }) {
    const org = await admin
      .from('organizations')
      .insert({ name: `kbtest-${stamp}` })
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
    const res = await ingestDocument({
      db: admin,
      organizationId: a.orgId,
      sourceUrl: 'https://example.com',
    });
    ingestedChunks = res.chunks;
  }, 120_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('ingested at least one embedded chunk for org A', () => {
    expect(ingestedChunks).toBeGreaterThan(0);
  });

  it('user-scoped client resolves the caller’s own org (users read self)', async () => {
    const db = userDb(a.token);
    const { data, error } = await db
      .from('users')
      .select('organization_id')
      .eq('id', a.userId)
      .single();
    expect(error).toBeNull();
    expect(data?.organization_id).toBe(a.orgId);
  });

  it('org A sees its own KB documents and search returns chunks', async () => {
    const db = userDb(a.token);
    const docs = await db.from('kb_documents').select('id');
    expect(docs.error).toBeNull();
    expect((docs.data ?? []).length).toBeGreaterThan(0);

    const match = await db.rpc('match_kb_chunks', {
      p_org_id: a.orgId,
      p_query_embedding: queryVec,
      p_match_count: 5,
    });
    expect(match.error).toBeNull();
    expect((match.data ?? []).length).toBeGreaterThan(0);
  });

  it('ISOLATION: org B cannot read org A’s documents, chunks, or search results', async () => {
    const db = userDb(b.token);

    const docs = await db.from('kb_documents').select('id');
    expect(docs.error).toBeNull();
    expect((docs.data ?? []).length).toBe(0);

    const chunks = await db.from('kb_chunks').select('id');
    expect(chunks.error).toBeNull();
    expect((chunks.data ?? []).length).toBe(0);

    // Even passing org A's id explicitly, RLS blocks reading A's chunks.
    const match = await db.rpc('match_kb_chunks', {
      p_org_id: a.orgId,
      p_query_embedding: queryVec,
      p_match_count: 5,
    });
    expect(match.error).toBeNull();
    expect((match.data ?? []).length).toBe(0);
  });

  it('ISOLATION: org B cannot write into org A (RLS WITH CHECK)', async () => {
    const db = userDb(b.token);
    const ins = await db
      .from('coaching_points')
      .insert({ organization_id: a.orgId, content: 'cross-tenant write attempt' })
      .select('id');
    expect(ins.error).not.toBeNull();
  });
});
