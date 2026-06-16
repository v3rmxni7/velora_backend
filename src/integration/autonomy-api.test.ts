import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { autonomyRoute } from '../api/routes/autonomy.js';
import { tasksRoute } from '../api/routes/tasks.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). User-scoped routes via app.inject + real JWTs. Proves Slice 3.6a: read the
// autonomy state + audit (org-isolated), the one-click PAUSE (idempotent, audited, off-only), and
// that reply_approval tasks are now listable/countable. Read + a protective flag-flip only.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(!ready)(
  'Slice 3.6a — autonomy API (state, events, pause) + reply_approval tasks',
  () => {
    const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anon = createClient(SUPABASE_URL, ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const stamp = Date.now();
    const A = { orgId: '', userId: '', email: `auto-a+${stamp}@example.com`, token: '' };
    const B = { orgId: '', userId: '', email: `auto-b+${stamp}@example.com`, token: '' };

    async function makeUser(
      acct: { orgId: string; userId: string; email: string; token: string },
      orgName: string,
    ) {
      const org = await admin.from('organizations').insert({ name: orgName }).select('id').single();
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
    }
    function app() {
      const f = Fastify();
      return f;
    }
    async function injectJson(token: string | null, method: 'GET' | 'POST', url: string) {
      const f = app();
      await f.register(autonomyRoute);
      await f.register(tasksRoute);
      const res = await f.inject({
        method,
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      await f.close();
      return res;
    }

    beforeAll(async () => {
      await makeUser(A, `auto-a-${stamp}`);
      await makeUser(B, `auto-b-${stamp}`);
      // Org A: autonomy on + relaxed reply mode.
      await admin
        .from('organizations')
        .update({ autonomy_enabled: true, auto_reply_mode: 'draft', auto_send_min_confidence: 0.8 })
        .eq('id', A.orgId);
      // Org A audit events — explicit distinct created_at so newest-first ordering is deterministic
      // (a batch insert shares one timestamp). The 'reply' row is the newer one.
      await admin.from('autonomy_events').insert([
        {
          organization_id: A.orgId,
          kind: 'cold_send',
          decision: 'auto_send',
          reason: 'personalized_verified_high_confidence',
          confidence: 0.9,
          created_at: new Date(stamp - 60_000).toISOString(),
        },
        {
          organization_id: A.orgId,
          kind: 'reply',
          decision: 'engage',
          reason: 'interested',
          created_at: new Date(stamp).toISOString(),
        },
      ]);
      // Org B audit event — MUST NOT leak into A's query.
      await admin.from('autonomy_events').insert({
        organization_id: B.orgId,
        kind: 'cold_send',
        decision: 'escalate',
        reason: 'unverified',
      });
      // Org A reply_approval task (pending) — listable/countable after the enum change.
      await admin.from('tasks').insert({
        organization_id: A.orgId,
        type: 'reply_approval',
        status: 'pending',
        lead_type: 'person',
        subject: 'Re: hi',
        body: 'Thanks — open to a call?',
        dedupe_key: `reply_draft:${A.orgId}:test:${stamp}`,
      });
    }, 180_000);

    afterAll(async () => {
      if (A.orgId) await admin.from('organizations').delete().eq('id', A.orgId);
      if (B.orgId) await admin.from('organizations').delete().eq('id', B.orgId);
      if (A.userId) await admin.auth.admin.deleteUser(A.userId);
      if (B.userId) await admin.auth.admin.deleteUser(B.userId);
    });

    it('GET /autonomy → the org flags + guardrail thresholds', async () => {
      const res = await injectJson(A.token, 'GET', '/autonomy');
      expect(res.statusCode).toBe(200);
      const { data } = res.json() as {
        data: {
          autonomyEnabled: boolean;
          autoReplyMode: string;
          autoSendMinConfidence: number;
          guardrails: Record<string, number>;
        };
      };
      expect(data.autonomyEnabled).toBe(true);
      expect(data.autoReplyMode).toBe('draft');
      expect(data.autoSendMinConfidence).toBeCloseTo(0.8, 3);
      expect(data.guardrails.bounceRate).toBe(env.ANOMALY_BOUNCE_RATE);
      expect(data.guardrails.windowHours).toBe(env.ANOMALY_WINDOW_HOURS);
    }, 60_000);

    it('GET /autonomy rejects an unauthenticated request', async () => {
      const res = await injectJson(null, 'GET', '/autonomy');
      expect(res.statusCode).toBe(401);
    });

    it('GET /autonomy/events → org A’s events newest-first; org B never leaks in', async () => {
      const a = await injectJson(A.token, 'GET', '/autonomy/events');
      expect(a.statusCode).toBe(200);
      const aBody = a.json() as {
        data: { events: { kind: string; decision: string }[]; count: number };
      };
      expect(aBody.data.count).toBe(2);
      expect(aBody.data.events.length).toBe(2);
      // Newest-first: the 'reply' row was inserted after the 'cold_send' row.
      expect(aBody.data.events[0]?.kind).toBe('reply');

      const b = await injectJson(B.token, 'GET', '/autonomy/events');
      const bBody = b.json() as { data: { events: { decision: string }[]; count: number } };
      expect(bBody.data.count).toBe(1); // only B's own — A's two never appear
      expect(bBody.data.events[0]?.decision).toBe('escalate');
    }, 60_000);

    it('GET /tasks?type=reply_approval lists it + /tasks/counts includes reply_approval', async () => {
      const list = await injectJson(A.token, 'GET', '/tasks?type=reply_approval');
      expect(list.statusCode).toBe(200);
      const listBody = list.json() as { data: { type: string }[] };
      expect(listBody.data.length).toBe(1);
      expect(listBody.data[0]?.type).toBe('reply_approval');

      const counts = await injectJson(A.token, 'GET', '/tasks/counts');
      const countsBody = counts.json() as { pending: Record<string, number> };
      expect(countsBody.pending.reply_approval).toBe(1);
    }, 60_000);

    // LAST — mutates org A (autonomy_enabled → false).
    it('POST /autonomy/pause → flips off + audits; idempotent; scoped to the caller’s org', async () => {
      const r1 = await injectJson(A.token, 'POST', '/autonomy/pause');
      expect(r1.statusCode).toBe(200);
      expect((r1.json() as { data: { paused: boolean } }).data.paused).toBe(true);
      const org = await admin
        .from('organizations')
        .select('autonomy_enabled')
        .eq('id', A.orgId)
        .single();
      expect(org.data?.autonomy_enabled).toBe(false);
      const audit = await admin
        .from('autonomy_events')
        .select('reason')
        .eq('organization_id', A.orgId)
        .eq('kind', 'auto_pause')
        .eq('decision', 'auto_pause');
      expect((audit.data ?? []).length).toBe(1);
      expect(audit.data?.[0]?.reason).toBe('manual_pause');

      // Idempotent: already off → no flip, no second audit.
      const r2 = await injectJson(A.token, 'POST', '/autonomy/pause');
      expect((r2.json() as { data: { paused: boolean } }).data.paused).toBe(false);
      const audit2 = await admin
        .from('autonomy_events')
        .select('id')
        .eq('organization_id', A.orgId)
        .eq('kind', 'auto_pause');
      expect((audit2.data ?? []).length).toBe(1);

      // Org B is untouched by A's pause.
      const orgB = await admin
        .from('organizations')
        .select('autonomy_enabled')
        .eq('id', B.orgId)
        .single();
      expect(orgB.data?.autonomy_enabled).toBe(false); // B was never enabled; A's call didn't change it
    }, 60_000);
  },
);
