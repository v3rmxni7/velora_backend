import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliverabilityRoute } from '../api/routes/deliverability.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB, user-scoped route via app.inject + a real JWT. Verifies the
// Deliverability metrics endpoint returns THIS ORG's figures only — and that dry-run messages and
// GLOBAL suppression rows are correctly excluded.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

interface DeliverabilityData {
  sends: { today: number; dailyCap: number; remaining: number };
  bounces: { total: number };
  suppression: { total: number; byReason: Record<string, number> };
  credits: { balance: number };
  mailboxes: { total: number; byStatus: Record<string, number> };
}

describe.skipIf(!ready)('GET /deliverability — org-scoped metrics (no global leak)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const acct = { orgId: '', userId: '', email: `deliv+${stamp}@example.com`, token: '' };
  let threadId = '';

  async function outbound(status: string, dedupe: string) {
    const m = await admin.from('messages').insert({
      organization_id: acct.orgId,
      thread_id: threadId,
      direction: 'outbound',
      channel: 'email',
      status,
      dedupe_key: dedupe,
    });
    if (m.error) throw m.error;
  }

  beforeAll(async () => {
    const org = await admin
      .from('organizations')
      .insert({ name: `deliv-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    acct.orgId = org.data.id as string;

    const pwd = `Test-${stamp}-pw!`;
    const created = await admin.auth.admin.createUser({
      email: acct.email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    acct.userId = created.data.user.id;
    await admin
      .from('users')
      .insert({ id: acct.userId, organization_id: acct.orgId, email: acct.email, role: 'owner' });
    const signin = await anon.auth.signInWithPassword({ email: acct.email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    acct.token = signin.data.session.access_token;

    // A thread to hang messages on (messages.thread_id is NOT NULL).
    const person = await admin
      .from('people')
      .insert({
        organization_id: acct.orgId,
        provider: 'seed',
        external_id: `d:${stamp}`,
        full_name: 'Lead',
        email: `lead+${stamp}@x.com`,
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (person.error) throw person.error;
    const t = await admin
      .from('threads')
      .insert({
        organization_id: acct.orgId,
        lead_type: 'person',
        lead_id: person.data.id,
        status: 'active',
      })
      .select('id')
      .single();
    if (t.error) throw t.error;
    threadId = t.data.id as string;

    // 4 real sends today (queued/sent/bounced) + 1 dry_run (must be EXCLUDED from sends.today).
    await outbound('queued', `s:${stamp}:1`);
    await outbound('queued', `s:${stamp}:2`);
    await outbound('sent', `s:${stamp}:3`);
    await outbound('bounced', `s:${stamp}:4`);
    await outbound('dry_run', `s:${stamp}:5`);

    // Suppression: 2 org rows + 1 GLOBAL row (organization_id NULL) that must be EXCLUDED.
    const sup = await admin.from('suppression_list').insert([
      { organization_id: acct.orgId, email: `b+${stamp}@x.com`, reason: 'bounce', source: 'test' },
      { organization_id: acct.orgId, email: `r+${stamp}@x.com`, reason: 'reply', source: 'test' },
      { organization_id: null, email: `g+${stamp}@x.com`, reason: 'unsubscribe', source: 'test' },
    ]);
    if (sup.error) throw sup.error;

    // Credits: +100 grant, -1 send → balance 99.
    const led = await admin.from('credit_ledger').insert([
      {
        organization_id: acct.orgId,
        delta: 100,
        reason: 'signup_grant',
        idempotency_key: `grant:${stamp}`,
      },
      { organization_id: acct.orgId, delta: -1, reason: 'send', idempotency_key: `send:${stamp}` },
    ]);
    if (led.error) throw led.error;

    // Mailboxes: one of each relevant warmth state.
    const mb = await admin.from('mailboxes').insert([
      { organization_id: acct.orgId, email: `w+${stamp}@x.com`, status: 'warm' },
      { organization_id: acct.orgId, email: `wing+${stamp}@x.com`, status: 'warming' },
      { organization_id: acct.orgId, email: `c+${stamp}@x.com`, status: 'connected' },
    ]);
    if (mb.error) throw mb.error;
  }, 180_000);

  afterAll(async () => {
    if (acct.orgId) await admin.from('organizations').delete().eq('id', acct.orgId);
    if (acct.userId) await admin.auth.admin.deleteUser(acct.userId);
    // The global suppression row has no org cascade — remove it explicitly.
    await admin.from('suppression_list').delete().like('email', `g+${stamp}@x.com`);
  });

  it('returns this org’s figures, excluding dry-run sends and global suppressions', async () => {
    const app = Fastify();
    await app.register(deliverabilityRoute);
    const res = await app.inject({
      method: 'GET',
      url: '/deliverability',
      headers: { authorization: `Bearer ${acct.token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: DeliverabilityData };

    // sends.today excludes the dry_run → 4; cap from env; remaining = cap - 4.
    expect(data.sends.today).toBe(4);
    expect(data.sends.dailyCap).toBe(env.DAILY_SEND_CAP_PER_ORG);
    expect(data.sends.remaining).toBe(Math.max(0, env.DAILY_SEND_CAP_PER_ORG - 4));

    expect(data.bounces.total).toBe(1);

    // suppression is org-only (global excluded) → total 2, byReason bounce+reply.
    expect(data.suppression.total).toBe(2);
    expect(data.suppression.byReason.bounce).toBe(1);
    expect(data.suppression.byReason.reply).toBe(1);
    expect(data.suppression.byReason.unsubscribe).toBeUndefined();

    expect(data.credits.balance).toBe(99);

    expect(data.mailboxes.total).toBe(3);
    expect(data.mailboxes.byStatus.warm).toBe(1);
    expect(data.mailboxes.byStatus.warming).toBe(1);
    expect(data.mailboxes.byStatus.connected).toBe(1);
  }, 60_000);

  it('rejects an unauthenticated request', async () => {
    const app = Fastify();
    await app.register(deliverabilityRoute);
    const res = await app.inject({ method: 'GET', url: '/deliverability' });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});
