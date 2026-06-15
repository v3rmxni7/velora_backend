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

  // Fake Smartlead client — returns two accounts + canned warmup stats. No network.
  const fake: SmartleadClient = {
    async listEmailAccounts() {
      return [
        {
          id: 901,
          from_email: `mb1+${stamp}@get-x.com`,
          type: 'GMAIL',
          max_email_per_day: 30,
          warmup_details: { status: 'ACTIVE', warmup_reputation: '100%' },
        },
        {
          id: 902,
          from_email: `mb2+${stamp}@get-x.com`,
          type: 'OUTLOOK',
          max_email_per_day: 25,
          warmup_details: { status: 'ACTIVE' },
        },
      ];
    },
    async getWarmupStats() {
      return { sent_count: 50, inbox_count: 48, spam_count: 2 };
    },
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
  }, 120_000);

  afterAll(async () => {
    if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
    if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
    if (a.userId) await admin.auth.admin.deleteUser(a.userId);
    if (b.userId) await admin.auth.admin.deleteUser(b.userId);
  });

  it('syncMailboxes upserts the org-scoped mailboxes from Smartlead (fake)', async () => {
    const dbA = userDb(a.token);
    const result = await syncMailboxes(dbA, a.orgId, fake);
    expect(result.synced).toBe(2);
    const mbs = await dbA
      .from('mailboxes')
      .select('email, provider, daily_cap, status, warmup_state');
    expect((mbs.data ?? []).length).toBe(2);
    const m1 = (mbs.data ?? []).find((m) => m.provider === 'gmail');
    expect(m1?.daily_cap).toBe(30);
    expect(m1?.status).toBe('warming');
    // idempotent re-sync → still 2 (upsert by org+email)
    await syncMailboxes(dbA, a.orgId, fake);
    expect(((await dbA.from('mailboxes').select('id')).data ?? []).length).toBe(2);
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

  it('CROSS-TENANT: org B sees none of org A’s mailboxes and cannot sync into org A', async () => {
    const dbB = userDb(b.token);
    expect(((await dbB.from('mailboxes').select('id')).data ?? []).length).toBe(0);
    // org B syncing under its own org never touches org A's rows
    await syncMailboxes(dbB, b.orgId, fake);
    const aCount = ((await userDb(a.token).from('mailboxes').select('id')).data ?? []).length;
    expect(aCount).toBe(2); // unchanged by org B's sync
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
