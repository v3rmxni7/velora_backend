import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendersRoute } from '../api/routes/senders.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB; routes via app.inject + a real JWT. Proves Slice 4.8a full sender
// config (REAL DB state): assign a user, assign/unassign a mailbox, set the PRIMARY (at-most-one per
// sender — DB-enforced), set sender status. No Smartlead, no send.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('Slice 4.8a — full sender config', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  let orgId = '';
  let userId = '';
  let token = '';
  let senderId = '';
  let mb1 = '';
  let mb2 = '';

  async function inject(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
    const app = Fastify();
    await app.register(sendersRoute);
    const res = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    await app.close();
    return res;
  }

  beforeAll(async () => {
    const org = await admin
      .from('organizations')
      .insert({ name: `sc-${stamp}` })
      .select('id')
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id as string;
    const pwd = `Test-${stamp}-pw!`;
    const created = await admin.auth.admin.createUser({
      email: `sc+${stamp}@example.com`,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    userId = created.data.user.id;
    await admin.from('users').insert({
      id: userId,
      organization_id: orgId,
      email: `sc+${stamp}@example.com`,
      role: 'owner',
    });
    const signin = await anon.auth.signInWithPassword({
      email: `sc+${stamp}@example.com`,
      password: pwd,
    });
    token = signin.data.session?.access_token as string;

    const sender = await admin
      .from('senders')
      .insert({ organization_id: orgId, display_name: 'SC Sender' })
      .select('id')
      .single();
    if (sender.error) throw sender.error;
    senderId = sender.data.id as string;
    for (const tag of ['mb1', 'mb2']) {
      const mb = await admin
        .from('mailboxes')
        .insert({ organization_id: orgId, email: `${tag}+${stamp}@x.com`, status: 'warm' })
        .select('id')
        .single();
      if (mb.error) throw mb.error;
      if (tag === 'mb1') mb1 = mb.data.id as string;
      else mb2 = mb.data.id as string;
    }
  }, 120_000);

  afterAll(async () => {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    if (userId) await admin.auth.admin.deleteUser(userId);
  });

  it('assigns a user to a sender; rejects a user not in the org (422)', async () => {
    const ok = await inject('PATCH', `/senders/${senderId}`, { userId });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.user_id).toBe(userId);
    const bad = await inject('PATCH', `/senders/${senderId}`, {
      userId: '00000000-0000-0000-0000-000000000000',
    });
    expect(bad.statusCode).toBe(422);
  }, 60_000);

  it('sets sender status', async () => {
    const res = await inject('PATCH', `/senders/${senderId}`, { status: 'paused' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('paused');
  }, 60_000);

  it('assigns + unassigns a mailbox to a sender', async () => {
    const assign = await inject('PATCH', `/mailboxes/${mb1}`, { senderId });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().data.sender_id).toBe(senderId);
    await inject('PATCH', `/mailboxes/${mb2}`, { senderId });
    const unassign = await inject('PATCH', `/mailboxes/${mb1}`, { senderId: null });
    expect(unassign.json().data.sender_id).toBeNull();
    // re-assign mb1 so both belong to the sender for the primary test
    await inject('PATCH', `/mailboxes/${mb1}`, { senderId });
  }, 60_000);

  it('sets the primary mailbox — at most ONE primary per sender (switching moves the flag)', async () => {
    const first = await inject('PATCH', `/senders/${senderId}/primary-mailbox`, { mailboxId: mb1 });
    expect(first.statusCode).toBe(200);
    let primaries =
      (await admin.from('mailboxes').select('id').eq('sender_id', senderId).eq('is_primary', true))
        .data ?? [];
    expect(primaries.length).toBe(1);
    expect(primaries[0]?.id).toBe(mb1);

    const second = await inject('PATCH', `/senders/${senderId}/primary-mailbox`, {
      mailboxId: mb2,
    });
    expect(second.statusCode).toBe(200);
    primaries =
      (await admin.from('mailboxes').select('id').eq('sender_id', senderId).eq('is_primary', true))
        .data ?? [];
    expect(primaries.length).toBe(1); // never two
    expect(primaries[0]?.id).toBe(mb2);

    // clear the primary
    const clear = await inject('PATCH', `/senders/${senderId}/primary-mailbox`, {
      mailboxId: null,
    });
    expect(clear.statusCode).toBe(200);
    primaries =
      (await admin.from('mailboxes').select('id').eq('sender_id', senderId).eq('is_primary', true))
        .data ?? [];
    expect(primaries.length).toBe(0);
  }, 60_000);
});
