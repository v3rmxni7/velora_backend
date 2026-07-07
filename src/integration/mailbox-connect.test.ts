import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendersRoute } from '../api/routes/senders.js';
import { env } from '../config/env.js';
import { createSandboxSmartleadClient } from '../integrations/smartlead/sandbox.js';
import type {
  SmartleadEmailAccountInput,
  SmartleadProvisioningClient,
} from '../integrations/smartlead/types.js';

// S3 — the SMTP mailbox-connect lane (RUN_DB_IT). The load-bearing test is the NEGATIVE one: the SMTP
// password must appear in NO column, NO response body, NO audit row, and NO log line — the pass-through
// guarantee is only as strong as its weakest exposure. Uses an injected FAKE provisioning client (no
// real Smartlead call); the fake captures the payload to prove the password IS passed through to
// Smartlead (and only there).
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)('S3 — mailbox connect (SMTP, password pass-through)', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anon = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const pwd = `Test-${stamp}-pw!`;
  const connectEmail = `connect-${stamp}@example.com`;
  const SECRET_PWD = `SUPER-SECRET-SMTP-${stamp}-DO-NOT-LEAK`;
  let orgA = '';
  const tok: Record<string, string> = {};
  const uid: Record<string, string> = {};
  const logs: string[] = [];

  const captured: { input?: SmartleadEmailAccountInput } = {};
  function fakeProvisioning(
    o: { smtpOk?: boolean; imapOk?: boolean } = {},
  ): SmartleadProvisioningClient {
    const acctId = `sl-acct-${stamp}`;
    return {
      async listEmailAccounts() {
        // The connected account, so syncMailboxes upserts it as 'warming' (warmup_details ACTIVE).
        return [
          {
            id: acctId,
            from_email: connectEmail,
            from_name: 'Connected',
            type: 'SMTP',
            warmup_details: { status: 'ACTIVE' },
          },
        ];
      },
      async getWarmupStats() {
        return { sent_count: 0, spam_count: 0 }; // no evidence yet → stays 'warming', never 'warm'
      },
      async createEmailAccount(input) {
        captured.input = input; // prove the password reaches Smartlead (and nowhere else)
        return { id: acctId, smtpOk: o.smtpOk ?? true, imapOk: o.imapOk ?? true };
      },
      async enableWarmup() {},
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

  // A Fastify app whose logs we CAPTURE, so we can assert the password never lands in a log line.
  function appWith(make: () => SmartleadProvisioningClient) {
    const f = Fastify({
      logger: { level: 'trace', stream: { write: (s: string) => logs.push(s) } },
    });
    return f.register(sendersRoute, { makeSmartleadClient: make }).then(() => f);
  }
  const body = (over: Partial<Record<string, unknown>> = {}) => ({
    fromName: 'Connected Sender',
    fromEmail: connectEmail,
    userName: connectEmail,
    password: SECRET_PWD,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    imapHost: 'imap.example.com',
    imapPort: 993,
    ...over,
  });
  const connect = (
    token: string | undefined,
    make: () => SmartleadProvisioningClient,
    payload = body(),
  ) =>
    appWith(make).then((f) =>
      f
        .inject({
          method: 'POST',
          url: '/mailboxes/connect',
          headers: { authorization: `Bearer ${token ?? ''}`, 'content-type': 'application/json' },
          payload: JSON.stringify(payload),
        })
        .then(async (res) => {
          await f.close();
          return res;
        }),
    );
  async function addUser(tag: string, role: 'owner' | 'admin' | 'member') {
    const email = `mc-${tag}+${stamp}@example.com`;
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

  beforeAll(async () => {
    orgA = (
      await admin
        .from('organizations')
        .insert({ name: `mc-${stamp}` })
        .select('id')
        .single()
    ).data?.id as string;
    await addUser('owner', 'owner');
    await addUser('member', 'member');
  }, 120_000);

  afterAll(async () => {
    if (orgA) await admin.from('organizations').delete().eq('id', orgA);
    for (const k of Object.keys(uid)) if (uid[k]) await admin.auth.admin.deleteUser(uid[k]);
  });

  it('OWNER connects → 200, mailbox lands WARMING (not warm), password passed through to Smartlead', async () => {
    const res = await connect(tok.owner, () => fakeProvisioning());
    expect(res.statusCode).toBe(200);
    // The password DID reach Smartlead (pass-through works)...
    expect(captured.input?.password).toBe(SECRET_PWD);
    // ...and the mailbox exists, WARMING — not 'warm' (grants no send capability).
    const mb = await admin
      .from('mailboxes')
      .select('*')
      .eq('organization_id', orgA)
      .eq('email', connectEmail)
      .single();
    expect(mb.data?.status).toBe('warming');
    expect(mb.data?.warmup_override).toBe(false);
    // Audited as mailbox_connected.
    const audit = await admin
      .from('audit_logs')
      .select('args')
      .eq('organization_id', orgA)
      .eq('kind', 'mailbox_connected');
    expect((audit.data ?? []).length).toBe(1);
  });

  it('THE PASSWORD APPEARS NOWHERE — not in any column, response body, audit row, or log line', async () => {
    // Every mailbox row for the org, serialized.
    const rows = await admin.from('mailboxes').select('*').eq('organization_id', orgA);
    expect(JSON.stringify(rows.data ?? [])).not.toContain(SECRET_PWD);
    // Every audit row for the org.
    const audit = await admin.from('audit_logs').select('*').eq('organization_id', orgA);
    expect(JSON.stringify(audit.data ?? [])).not.toContain(SECRET_PWD);
    // The full captured log stream from the connect request(s).
    expect(logs.join('\n')).not.toContain(SECRET_PWD);
    // A fresh response body (success) — never echoes the password.
    const res = await connect(tok.owner, () => fakeProvisioning());
    expect(res.body).not.toContain(SECRET_PWD);
    expect(logs.join('\n')).not.toContain(SECRET_PWD); // still clean after another call
  });

  it('bad credentials (is_smtp_success/is_imap_success false at HTTP 200) → 422, no mailbox, no leak', async () => {
    const badEmail = `bad-${stamp}@example.com`;
    const res = await connect(
      tok.owner,
      () => fakeProvisioning({ smtpOk: false }),
      body({ fromEmail: badEmail, userName: badEmail }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(SECRET_PWD); // error body never echoes the password
    const mb = await admin
      .from('mailboxes')
      .select('id')
      .eq('organization_id', orgA)
      .eq('email', badEmail);
    expect((mb.data ?? []).length).toBe(0); // no mailbox created on a failed connect
  });

  it('MEMBER is 403 (owner/admin only)', async () => {
    const res = await connect(tok.member, () => fakeProvisioning());
    expect(res.statusCode).toBe(403);
  });

  it('no Smartlead key (sandbox) → 503, never a real provision', async () => {
    const res = await connect(tok.owner, () => createSandboxSmartleadClient());
    expect(res.statusCode).toBe(503);
  });
});
