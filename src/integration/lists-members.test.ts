import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listsRoute } from '../api/routes/lists.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). User-scoped route via app.inject + a real JWT. Verifies GET /lists/:id/members
// hydrates members with their lead records (single .in() per type, not N+1), counts/paginates, and
// — critically — confines everything to the caller's org (cross-tenant 404).
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

interface HydratedMember {
  id: string;
  entity_type: string;
  entity_id: string;
  added_at: string;
  lead: Record<string, unknown> | null;
}
interface MembersData {
  count: number;
  limit: number;
  offset: number;
  members: HydratedMember[];
}

describe.skipIf(!ready)('GET /lists/:id/members — hydrated + org-scoped', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();

  async function makeUser(orgName: string, email: string) {
    const org = await admin.from('organizations').insert({ name: orgName }).select('id').single();
    if (org.error) throw org.error;
    const orgId = org.data.id as string;
    const pwd = `Test-${stamp}-pw!`;
    const created = await admin.auth.admin.createUser({
      email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    const userId = created.data.user.id;
    await admin.from('users').insert({ id: userId, organization_id: orgId, email, role: 'owner' });
    const signin = await anon.auth.signInWithPassword({ email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    return { orgId, userId, token: signin.data.session.access_token };
  }
  async function makeList(orgId: string, name: string, entityType: string) {
    const l = await admin
      .from('lists')
      .insert({ organization_id: orgId, name, entity_type: entityType })
      .select('id')
      .single();
    if (l.error) throw l.error;
    return l.data.id as string;
  }
  async function addMember(orgId: string, listId: string, entityType: string, entityId: string) {
    const m = await admin.from('list_members').insert({
      organization_id: orgId,
      list_id: listId,
      entity_type: entityType,
      entity_id: entityId,
    });
    if (m.error) throw m.error;
  }

  let A = { orgId: '', userId: '', token: '' };
  let B = { orgId: '', userId: '', token: '' };
  let personList = '';
  let companyList = '';
  const fullNames = [`Ada ${stamp}`, `Grace ${stamp}`];

  beforeAll(async () => {
    A = await makeUser(`lm-a-${stamp}`, `lma+${stamp}@example.com`);
    B = await makeUser(`lm-b-${stamp}`, `lmb+${stamp}@example.com`);

    // Person list: 2 real people + 1 orphan member (bogus entity_id → lead null).
    personList = await makeList(A.orgId, 'People list', 'person');
    for (let i = 0; i < 2; i++) {
      const p = await admin
        .from('people')
        .insert({
          organization_id: A.orgId,
          provider: 'seed',
          external_id: `lm-p${i}:${stamp}`,
          full_name: fullNames[i],
          title: 'CTO',
          company_name: 'Co',
          source: 'find_leads',
        })
        .select('id')
        .single();
      if (p.error) throw p.error;
      await addMember(A.orgId, personList, 'person', p.data.id as string);
    }
    await addMember(A.orgId, personList, 'person', '00000000-0000-0000-0000-0000000000ff'); // orphan

    // Company list: 1 company.
    companyList = await makeList(A.orgId, 'Company list', 'company');
    const c = await admin
      .from('companies')
      .insert({
        organization_id: A.orgId,
        provider: 'seed',
        external_id: `lm-c:${stamp}`,
        name: `Acme ${stamp}`,
        industry: 'saas',
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (c.error) throw c.error;
    await addMember(A.orgId, companyList, 'company', c.data.id as string);
  }, 180_000);

  afterAll(async () => {
    if (A.orgId) await admin.from('organizations').delete().eq('id', A.orgId);
    if (B.orgId) await admin.from('organizations').delete().eq('id', B.orgId);
    if (A.userId) await admin.auth.admin.deleteUser(A.userId);
    if (B.userId) await admin.auth.admin.deleteUser(B.userId);
  });

  async function get(token: string, listId: string, qs = '') {
    const app = Fastify();
    await app.register(listsRoute);
    const res = await app.inject({
      method: 'GET',
      url: `/lists/${listId}/members${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();
    return res;
  }

  it('hydrates person members (names) + counts; orphan member → lead null', async () => {
    const res = await get(A.token, personList);
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: MembersData };
    expect(data.count).toBe(3);
    expect(data.members.length).toBe(3);
    const named = data.members.filter((m) => m.lead);
    const orphan = data.members.filter((m) => !m.lead);
    expect(named.length).toBe(2);
    expect(orphan.length).toBe(1);
    const names = named.map((m) => m.lead?.full_name).sort();
    expect(names).toEqual([...fullNames].sort());
    expect(named[0]?.entity_id).toBeTruthy();
    expect(named[0]?.added_at).toBeTruthy();
  }, 60_000);

  it('hydrates company members (name)', async () => {
    const res = await get(A.token, companyList);
    const { data } = res.json() as { data: MembersData };
    expect(data.count).toBe(1);
    expect(data.members[0]?.lead?.name).toBe(`Acme ${stamp}`);
  }, 60_000);

  it('paginates — limit caps the page, count stays the true total', async () => {
    const res = await get(A.token, personList, '?limit=1');
    const { data } = res.json() as { data: MembersData };
    expect(data.members.length).toBe(1);
    expect(data.count).toBe(3);
    expect(data.limit).toBe(1);
  }, 60_000);

  it('cross-tenant: org B cannot read org A’s list members → 404', async () => {
    const res = await get(B.token, personList);
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it('rejects an unauthenticated request', async () => {
    const app = Fastify();
    await app.register(listsRoute);
    const res = await app.inject({ method: 'GET', url: `/lists/${personList}/members` });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});
