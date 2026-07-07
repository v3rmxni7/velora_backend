import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refreshMailboxWarmup } from '../agents/sending/mailbox-sync.js';
import { sendersRoute } from '../api/routes/senders.js';
import { env } from '../config/env.js';
import { createUserClient } from '../db/user-client.js';
import type { SmartleadClient } from '../integrations/smartlead/types.js';

// A fake Smartlead client whose warmup stats we control (to drive classifyWarmth's spam ceiling).
function fakeWarmupClient(sent: number, spam: number): SmartleadClient {
  return {
    async listEmailAccounts() {
      return [];
    },
    async getWarmupStats() {
      return { sent_count: sent, spam_count: spam } as never;
    },
    async createCampaign() {
      return { id: 'x' };
    },
    async saveSequence() {},
    async assignEmailAccounts() {},
    async setSchedule() {},
    async setStatus() {},
    async addLead() {},
    async sendReply() {},
  };
}

// S2 — the mailbox warmup-override owner gate (RUN_DB_IT). warmup_override / status='warm' GRANT a
// mailbox send-eligibility without warm-up proof, so they must be an OWNER act. The route gives a clean
// 403, but the REAL boundary is the mailboxes_owner_send_eligibility DB trigger (mailboxes has a broad
// authenticated UPDATE RLS policy, so a member could otherwise flip it directly via PostgREST). This
// asserts: owner via route succeeds + is audited; member via route 403; member DIRECT RLS write blocked
// by the trigger (the bypass-closed proof); the sync re-warm exemption + service-role still work.
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('S2 — mailbox warmup-override owner gate', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  let orgA = '';
  let mbId = '';
  const tok: Record<string, string> = {};
  const uid: Record<string, string> = {};

  function appFor() {
    const f = Fastify();
    return f.register(sendersRoute).then(() => f);
  }
  async function addUser(tag: string, role: 'owner' | 'member') {
    const email = `wo-${tag}+${stamp}@example.com`;
    const created = await admin.auth.admin.createUser({
      email,
      password: pwd,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
    uid[tag] = created.data.user.id;
    const link = await admin
      .from('users')
      .insert({ id: created.data.user.id, organization_id: orgA, email, role });
    if (link.error) throw link.error;
    const signin = await anon.auth.signInWithPassword({ email, password: pwd });
    if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
    tok[tag] = signin.data.session.access_token;
  }
  // Reset the mailbox to a known state via the SERVICE-ROLE admin (bypasses the trigger).
  async function reset(state: { warmup_override: boolean; status: string }) {
    const r = await admin.from('mailboxes').update(state).eq('id', mbId).select('id');
    if (r.error) throw r.error;
  }
  const readMb = async () =>
    (await admin.from('mailboxes').select('warmup_override, status').eq('id', mbId).single())
      .data as { warmup_override: boolean; status: string };
  const patch = (token: string | undefined, override: boolean) =>
    appFor().then((f) =>
      f
        .inject({
          method: 'PATCH',
          url: `/mailboxes/${mbId}/warmup-override`,
          headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
          payload: JSON.stringify({ override }),
        })
        .then(async (res) => {
          await f.close();
          return res;
        }),
    );
  const auditCount = async () =>
    (
      (
        await admin
          .from('audit_logs')
          .select('id')
          .eq('organization_id', orgA)
          .eq('kind', 'mailbox_warmup_override_set')
      ).data ?? []
    ).length;

  beforeAll(async () => {
    orgA = (
      await admin
        .from('organizations')
        .insert({ name: `wo-${stamp}` })
        .select('id')
        .single()
    ).data?.id as string;
    await addUser('owner', 'owner');
    await addUser('member', 'member');
    mbId = (
      await admin
        .from('mailboxes')
        .insert({
          organization_id: orgA,
          email: `wo-mb-${stamp}@x.com`,
          smartlead_email_account_id: `wo-acct-${stamp}`,
          status: 'warming',
        })
        .select('id')
        .single()
    ).data?.id as string;
  }, 120_000);

  afterAll(async () => {
    if (orgA) await admin.from('organizations').delete().eq('id', orgA);
    for (const k of Object.keys(uid)) if (uid[k]) await admin.auth.admin.deleteUser(uid[k]);
  });

  it('OWNER via route sets the override (→ warm) and it is audited', async () => {
    await reset({ warmup_override: false, status: 'warming' });
    const before = await auditCount();
    const res = await patch(tok.owner, true);
    expect(res.statusCode).toBe(200);
    const mb = await readMb();
    expect(mb.warmup_override).toBe(true);
    expect(mb.status).toBe('warm');
    expect(await auditCount()).toBe(before + 1);
  });

  it('OWNER via route clears the override (→ warming)', async () => {
    await reset({ warmup_override: true, status: 'warm' });
    const res = await patch(tok.owner, false);
    expect(res.statusCode).toBe(200);
    const mb = await readMb();
    expect(mb.warmup_override).toBe(false);
    expect(mb.status).toBe('warming');
  });

  it('MEMBER via route is 403; nothing changes, nothing audited', async () => {
    await reset({ warmup_override: false, status: 'warming' });
    const before = await auditCount();
    const res = await patch(tok.member, true);
    expect(res.statusCode).toBe(403);
    const mb = await readMb();
    expect(mb.warmup_override).toBe(false); // unchanged
    expect(await auditCount()).toBe(before); // no audit row
  });

  it('MEMBER DIRECT RLS write of warmup_override=true is BLOCKED by the trigger (bypass closed)', async () => {
    await reset({ warmup_override: false, status: 'warming' });
    const db = createUserClient(tok.member ?? '');
    if (!db) throw new Error('user client unavailable');
    const upd = await db
      .from('mailboxes')
      .update({ warmup_override: true })
      .eq('id', mbId)
      .select('id');
    expect(upd.error).toBeTruthy(); // trigger raised (42501)
    expect((await readMb()).warmup_override).toBe(false); // still off
  });

  it('MEMBER DIRECT RLS write of status=warm on a NON-overridden mailbox is BLOCKED by the trigger', async () => {
    await reset({ warmup_override: false, status: 'warming' });
    const db = createUserClient(tok.member ?? '');
    if (!db) throw new Error('user client unavailable');
    const upd = await db.from('mailboxes').update({ status: 'warm' }).eq('id', mbId).select('id');
    expect(upd.error).toBeTruthy();
    expect((await readMb()).status).toBe('warming');
  });

  it('SYNC-SAFE — a member may set status=warm on an ALREADY-overridden mailbox (the re-warm exemption)', async () => {
    await reset({ warmup_override: true, status: 'warming' }); // owner-attested, awaiting re-warm
    const db = createUserClient(tok.member ?? '');
    if (!db) throw new Error('user client unavailable');
    const upd = await db.from('mailboxes').update({ status: 'warm' }).eq('id', mbId).select('id');
    expect(upd.error).toBeNull(); // exemption: warmup_override=true → allowed (mirrors syncMailboxes)
    expect((await readMb()).status).toBe('warm');
  });

  it('OWNER is not over-blocked — a direct RLS write of warmup_override=true succeeds', async () => {
    await reset({ warmup_override: false, status: 'warming' });
    const db = createUserClient(tok.owner ?? '');
    if (!db) throw new Error('user client unavailable');
    const upd = await db
      .from('mailboxes')
      .update({ warmup_override: true })
      .eq('id', mbId)
      .select('id');
    expect(upd.error).toBeNull();
    expect((await readMb()).warmup_override).toBe(true);
  });

  it('SPAM CEILING wins over override — a refresh that trips the spam rate CLEARS the override (durable demotion)', async () => {
    await reset({ warmup_override: true, status: 'warm' });
    // 20% spam rate (> MAX_SPAM_RATE) on an owner-attested mailbox.
    await refreshMailboxWarmup(admin, fakeWarmupClient(1000, 200), mbId);
    const mb = await readMb();
    expect(mb.status).toBe('warming'); // demoted by the spam ceiling
    expect(mb.warmup_override).toBe(false); // AND the override cleared → demotion is durable
  });

  it('a HEALTHY refresh keeps an override mailbox warm and KEEPS the override', async () => {
    await reset({ warmup_override: true, status: 'warm' });
    await refreshMailboxWarmup(admin, fakeWarmupClient(1000, 0), mbId); // 0% spam
    const mb = await readMb();
    expect(mb.status).toBe('warm');
    expect(mb.warmup_override).toBe(true); // override preserved when healthy
  });
});
