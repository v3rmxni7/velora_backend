import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nlToFiltersPerson } from '../agents/leads/filters.js';
import { icpSuggestions } from '../agents/leads/icp.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';
import { createSeedProvider } from '../integrations/leads/seed.js';

// Opt-in (RUN_DB_IT=1) — hits the live DB + a real Anthropic call (a few cents).
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY &&
  !!env.ANTHROPIC_API_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('Slice 2 live — Find leads + tenant isolation', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a = { orgId: '', userId: '', email: `s2+${stamp}-a@example.com`, token: '' };
  const b = { orgId: '', userId: '', email: `s2+${stamp}-b@example.com`, token: '' };

  function userDb(token: string) {
    const db = createUserClient(token);
    if (!db) throw new Error('user-scoped client unavailable');
    return db;
  }

  async function makeOrgUser(o: { orgId: string; userId: string; email: string; token: string }) {
    const org = await admin
      .from('organizations')
      .insert({ name: `s2-${stamp}` })
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
      content: 'We sell developer tooling to SaaS engineering teams at mid-size companies.',
    });
    await admin.from('proof_items').insert({
      organization_id: a.orgId,
      category: 'customer',
      title: 'Acme SaaS',
      body: 'Cut onboarding time by 40%.',
    });
  }, 120_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('NL→filters (live Anthropic) yields a valid, bounded filter the provider can run', async () => {
    const filters = await nlToFiltersPerson('SaaS founders and CTOs at mid-size companies, max 10');
    expect(filters.limit).toBeGreaterThanOrEqual(1);
    expect(filters.limit).toBeLessThanOrEqual(100);
    const results = await createSeedProvider().searchPeople(filters);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeLessThanOrEqual(filters.limit);
  }, 60_000);

  it('ICP suggestions (live Anthropic) generated from the org KB', async () => {
    const s = await icpSuggestions({
      coachingPoints: ['We sell developer tooling to SaaS engineering teams.'],
      proofItems: ['Acme SaaS — cut onboarding 40%'],
    });
    expect(s.length).toBeGreaterThan(0);
    expect(['person', 'company', 'local_business']).toContain(s[0]?.entityType);
  }, 60_000);

  it('ISOLATION: org B cannot read or write org A leads/lists/members', async () => {
    const dbA = userDb(a.token);
    const dbB = userDb(b.token);

    const person = await dbA
      .from('people')
      .insert({
        organization_id: a.orgId,
        provider: 'seed',
        external_id: `it:${stamp}`,
        full_name: 'Isolation Person',
        title: 'CEO',
        seniority: 'c_level',
        department: 'other',
        source: 'find_leads',
      })
      .select('id')
      .single();
    expect(person.error).toBeNull();
    const list = await dbA
      .from('lists')
      .insert({ organization_id: a.orgId, name: 'A list', entity_type: 'person' })
      .select('id')
      .single();
    expect(list.error).toBeNull();
    if (!person.data || !list.data) throw new Error('setup insert returned no row');
    const member = await dbA.from('list_members').insert({
      organization_id: a.orgId,
      list_id: list.data.id as string,
      entity_type: 'person',
      entity_id: person.data.id as string,
    });
    expect(member.error).toBeNull();

    expect(((await dbB.from('people').select('id')).data ?? []).length).toBe(0);
    expect(((await dbB.from('lists').select('id')).data ?? []).length).toBe(0);
    expect(((await dbB.from('list_members').select('id')).data ?? []).length).toBe(0);

    const evil = await dbB
      .from('people')
      .insert({
        organization_id: a.orgId,
        provider: 'seed',
        external_id: `evil:${stamp}`,
        full_name: 'x',
        source: 'find_leads',
      })
      .select('id');
    expect(evil.error).not.toBeNull();
  }, 60_000);
});
