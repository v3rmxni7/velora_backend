import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshMailboxWarmup, syncMailboxes } from '../agents/sending/mailbox-sync.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';
import type { SmartleadClient } from '../integrations/smartlead/types.js';

// Opt-in (RUN_DB_IT=1) — live DB only, NO Smartlead key needed (injected fake client). No email.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('Slice 2.1 live — mailbox sync + sending tenant isolation', () => {
  const admin = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const a = { orgId: '', userId: '', email: `s21+${stamp}-a@example.com`, token: '' };
  const b = { orgId: '', userId: '', email: `s21+${stamp}-b@example.com`, token: '' };
  const c = { orgId: '', userId: '', email: `s21+${stamp}-c@example.com`, token: '' };

  // Fake Smartlead client — returns the ACCOUNT-GLOBAL list: EVERY tenant's accounts under the shared
  // master key (org A's 901/902 AND org B's 903/904). It is deliberately caller-BLIND, exactly like the
  // real global key, so isolation MUST be enforced by syncMailboxes' ownership filter, not the list.
  const fake: SmartleadClient = {
    async listEmailAccounts() {
      return [
        { id: 901, from_email: `mb1+${stamp}@get-a.com`, type: 'GMAIL', max_email_per_day: 30, warmup_details: { status: 'ACTIVE', warmup_reputation: '100%' } },
        { id: 902, from_email: `mb2+${stamp}@get-a.com`, type: 'OUTLOOK', max_email_per_day: 25, warmup_details: { status: 'ACTIVE' } },
        { id: 903, from_email: `mb3+${stamp}@get-b.com`, type: 'GMAIL', max_email_per_day: 40, warmup_details: { status: 'ACTIVE' } },
        { id: 904, from_email: `mb4+${stamp}@get-b.com`, type: 'SMTP', max_email_per_day: 20, warmup_details: { status: 'ACTIVE' } },
      ];
    },
    async getWarmupStats() {
      return { sent_count: 50, inbox_count: 48, spam_count: 2 };
    },
    // write methods (unused by 2.1 sync; present to satisfy the SmartleadClient contract)
    async createCampaign() {
      return { id: 'noop' };
    },
    async saveSequence() {},
    async assignEmailAccounts() {},
    async setSchedule() {},
    async setStatus() {},
    async addLead() {},
    async sendReply() {},
  };

  function userDb(token: string) {
    const db = createUserClient(token);
    if (!db) throw new Error('user-scoped client unavailable');
    return db;
  }

  async function makeOrgUser(o: { orgId: string; userId: string; email: string; token: string }) {
    const org = await admin
      .from('organizations')
      .insert({ name: `s21-${stamp}` })
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
    await makeOrgUser(c);
  }, 120_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (c.orgId) await admin.from('organizations').delete().eq('id', c.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
    if (c.userId) await admin.auth.admin.deleteUser(c.userId);
  });

  it('connect-lane adoption: syncMailboxes adopts ONLY the allow-listed ids from the account-global list', async () => {
    const dbA = userDb(a.token);
    // A connects its two mailboxes; the S3 connect lane passes their Smartlead ids as the adopt-allowlist.
    const result = await syncMailboxes(dbA, a.orgId, fake, {
      adoptAccountIds: ['901', '902'],
      ownedOnly: true,
    });
    expect(result.synced).toBe(2);
    const mbs = await dbA
      .from('mailboxes')
      .select('provider, daily_cap, status, smartlead_email_account_id');
    const ids = (mbs.data ?? []).map((m) => String(m.smartlead_email_account_id)).sort();
    expect(ids).toEqual(['901', '902']); // NOT 903/904 — though the global fake returned all four
    const m1 = (mbs.data ?? []).find((m) => m.provider === 'gmail');
    expect(m1?.daily_cap).toBe(30);
    expect(m1?.status).toBe('warming');
  }, 60_000);

  it('idempotent re-sync keeps owned, adopts no other tenant’s accounts', async () => {
    const dbA = userDb(a.token);
    await syncMailboxes(dbA, a.orgId, fake, { ownedOnly: true }); // no adopt list this time
    const ids = ((await dbA.from('mailboxes').select('smartlead_email_account_id')).data ?? [])
      .map((m) => String(m.smartlead_email_account_id))
      .sort();
    expect(ids).toEqual(['901', '902']); // still exactly A's two; 903/904 never adopted
  }, 60_000);

  it('refreshMailboxWarmup writes the reputation blob', async () => {
    const dbA = userDb(a.token);
    const one = await dbA.from('mailboxes').select('id').limit(1).single();
    const res = await refreshMailboxWarmup(dbA, fake, one.data?.id as string);
    expect(res.ok).toBe(true);
    const after = await dbA
      .from('mailboxes')
      .select('reputation, last_synced_at')
      .eq('id', one.data?.id)
      .single();
    expect((after.data?.reputation as { sent?: number })?.sent).toBe(50);
    expect(after.data?.last_synced_at).toBeTruthy();
  }, 60_000);

  it('TENANT LEAK BLOCKED (fail-closed): an org that owns nothing adopts NOTHING from the global list', async () => {
    const dbB = userDb(b.token);
    expect(((await dbB.from('mailboxes').select('id')).data ?? []).length).toBe(0);
    // B plain-syncs against the 4-account global fake with no ownership → adopts 0. Under the pre-Phase-2
    // code this would have pulled ALL FOUR (incl. org A's) into org B — the exact leak this closes.
    const res = await syncMailboxes(dbB, b.orgId, fake, { ownedOnly: true });
    expect(res.synced).toBe(0);
    expect(((await dbB.from('mailboxes').select('id')).data ?? []).length).toBe(0);
  }, 60_000);

  it('TENANT ISOLATION (disjoint): B adopts only its own; A and B mailbox sets share nothing', async () => {
    const dbB = userDb(b.token);
    await syncMailboxes(dbB, b.orgId, fake, { adoptAccountIds: ['903', '904'], ownedOnly: true });
    const bIds = ((await dbB.from('mailboxes').select('smartlead_email_account_id')).data ?? [])
      .map((m) => String(m.smartlead_email_account_id))
      .sort();
    expect(bIds).toEqual(['903', '904']);
    const aIds = ((await userDb(a.token).from('mailboxes').select('smartlead_email_account_id')).data ?? [])
      .map((m) => String(m.smartlead_email_account_id))
      .sort();
    expect(aIds).toEqual(['901', '902']); // A untouched by B's sync
    expect(aIds.filter((x) => bIds.includes(x))).toEqual([]); // provably disjoint — the isolation proof
  }, 60_000);

  it('KILL-SWITCH (ownedOnly=false) restores legacy adopt-ALL — proves the flag gates the filter', async () => {
    const dbC = userDb(c.token);
    // Filter OFF → a plain sync adopts EVERY account in the global list (the pre-Phase-2 leak behavior).
    const res = await syncMailboxes(dbC, c.orgId, fake, { ownedOnly: false });
    expect(res.synced).toBe(4);
    expect(((await dbC.from('mailboxes').select('id')).data ?? []).length).toBe(4);
  }, 60_000);

  it('domains + senders CRUD round-trip under RLS; cross-tenant blocked', async () => {
    const dbA = userDb(a.token);
    const dbB = userDb(b.token);
    const dom = await dbA
      .from('domains')
      .insert({ organization_id: a.orgId, domain: `get-${stamp}.com` })
      .select('id')
      .single();
    expect(dom.error).toBeNull();
    const snd = await dbA
      .from('senders')
      .insert({ organization_id: a.orgId, user_id: a.userId, display_name: 'Nischay' })
      .select('id')
      .single();
    expect(snd.error).toBeNull();
    expect(((await dbB.from('domains').select('id')).data ?? []).length).toBe(0);
    expect(((await dbB.from('senders').select('id')).data ?? []).length).toBe(0);
  }, 60_000);
});
