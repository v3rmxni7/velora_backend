import { createHmac } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assessHealth, computeOrgHealth } from '../agents/sending/anomaly.js';
import { applySmartleadEvent } from '../agents/sending/inbound.js';
import { prepareEnrollment } from '../agents/sending/pipeline.js';
import { webhooksRoute } from '../api/routes/webhooks.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB, SIMULATED Smartlead webhooks, service-role client (exactly what
// the real webhook route uses). NO real email, NO Smartlead, NO LLM (classifier is faked). Proves
// Slice 2.6: replies halt + escalate, bounces/unsubs suppress, all org-scoped + idempotent.
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const fakeClassify = async () => 'interested' as const;

describe.skipIf(!ready)(
  'Slice 2.6 — inbound events (reply/bounce/unsub) via simulated webhooks',
  () => {
    const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const stamp = Date.now();
    const slCampaignId = `sl-camp-26-${stamp}`;
    const replyEmail = `reply+${stamp}@example.com`;
    const bounceEmail = `bounce+${stamp}@example.com`;
    const unsubEmail = `unsub+${stamp}@example.com`;
    const complaintEmail = `complaint+${stamp}@example.com`;

    let orgA = '';
    let orgB = '';
    let campaignA = '';
    const enr: Record<string, string> = {}; // email → enrollment id

    async function makeOrg(name: string): Promise<string> {
      const o = await admin.from('organizations').insert({ name }).select('id').single();
      if (o.error) throw o.error;
      return o.data.id as string;
    }
    async function makeCampaign(org: string, slId: string): Promise<string> {
      const c = await admin
        .from('campaigns')
        .insert({
          organization_id: org,
          name: 'Inbound',
          campaign_type: 'cold_outbound',
          status: 'active',
          smartlead_campaign_id: slId,
        })
        .select('id')
        .single();
      if (c.error) throw c.error;
      return c.data.id as string;
    }
    // Seed a lead that has already been "sent": person → thread → enrollment(sent) → outbound message.
    async function makeSent(
      org: string,
      campaign: string,
      email: string,
      ext: string,
    ): Promise<string> {
      const p = await admin
        .from('people')
        .insert({
          organization_id: org,
          provider: 'seed',
          external_id: ext,
          full_name: 'Lead',
          email,
          title: 'CTO',
          company_name: 'Co',
          source: 'find_leads',
        })
        .select('id')
        .single();
      if (p.error) throw p.error;
      const leadId = p.data.id as string;

      const t = await admin
        .from('threads')
        .insert({
          organization_id: org,
          campaign_id: campaign,
          lead_type: 'person',
          lead_id: leadId,
          subject: 'Hi',
          status: 'active',
          last_message_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (t.error) throw t.error;
      const threadId = t.data.id as string;

      const e = await admin
        .from('enrollments')
        .insert({
          organization_id: org,
          campaign_id: campaign,
          lead_type: 'person',
          lead_id: leadId,
          status: 'sent',
          current_step: 1,
          verified_email: email,
          thread_id: threadId,
        })
        .select('id')
        .single();
      if (e.error) throw e.error;
      const enrollmentId = e.data.id as string;

      const m = await admin.from('messages').insert({
        organization_id: org,
        thread_id: threadId,
        enrollment_id: enrollmentId,
        direction: 'outbound',
        channel: 'email',
        subject: 'Hi',
        body: 'Hello there',
        status: 'sent',
        dedupe_key: `send:${org}:${enrollmentId}:1`,
      });
      if (m.error) throw m.error;
      return enrollmentId;
    }

    beforeAll(async () => {
      orgA = await makeOrg(`s26a-${stamp}`);
      orgB = await makeOrg(`s26b-${stamp}`);
      campaignA = await makeCampaign(orgA, slCampaignId);
      const campaignB = await makeCampaign(orgB, `sl-camp-26b-${stamp}`);
      enr[replyEmail] = await makeSent(orgA, campaignA, replyEmail, `r:${stamp}`);
      enr[bounceEmail] = await makeSent(orgA, campaignA, bounceEmail, `b:${stamp}`);
      enr[unsubEmail] = await makeSent(orgA, campaignA, unsubEmail, `u:${stamp}`);
      enr[complaintEmail] = await makeSent(orgA, campaignA, complaintEmail, `c:${stamp}`);
      // Cross-tenant trap: org B has an enrollment with the SAME email as org A's reply lead.
      enr[`B:${replyEmail}`] = await makeSent(orgB, campaignB, replyEmail, `rb:${stamp}`);
    }, 180_000);

    afterAll(async () => {
      if (orgA) await admin.from('organizations').delete().eq('id', orgA);
      if (orgB) await admin.from('organizations').delete().eq('id', orgB);
    });

    it('EMAIL_REPLY → inbound message + classified + thread needs_action + enrollment replied (HALT); idempotent', async () => {
      const event = {
        event_type: 'EMAIL_REPLY',
        campaign_id: slCampaignId,
        to_email: replyEmail,
        message_id: 'r1',
        reply_body: 'Sure, let us talk next week',
      };
      const res = await applySmartleadEvent(admin, event, { classify: fakeClassify });
      expect(res.handled).toBe(true);

      const inbound = await admin
        .from('messages')
        .select('status, category, body')
        .eq('enrollment_id', enr[replyEmail])
        .eq('direction', 'inbound');
      expect((inbound.data ?? []).length).toBe(1);
      expect(inbound.data?.[0]?.status).toBe('replied');
      expect(inbound.data?.[0]?.category).toBe('interested');

      const thr = await admin
        .from('threads')
        .select('status')
        .eq(
          'id',
          (await admin.from('enrollments').select('thread_id').eq('id', enr[replyEmail]).single())
            .data?.thread_id,
        )
        .single();
      expect(thr.data?.status).toBe('needs_action');

      const e = await admin.from('enrollments').select('*').eq('id', enr[replyEmail]).single();
      expect(e.data?.status).toBe('replied');

      // HALT: a replied enrollment is terminal — prepareEnrollment refuses to re-process it.
      const halt = await prepareEnrollment(admin, e.data as never, {}, null);
      expect(halt.outcome).toBe('skipped');

      // Idempotent: re-applying the same webhook writes no second inbound message.
      await applySmartleadEvent(admin, event, { classify: fakeClassify });
      const again = await admin
        .from('messages')
        .select('id')
        .eq('enrollment_id', enr[replyEmail])
        .eq('direction', 'inbound');
      expect((again.data ?? []).length).toBe(1);

      // Cross-tenant: org B's same-email enrollment is untouched.
      const b = await admin
        .from('enrollments')
        .select('status')
        .eq('id', enr[`B:${replyEmail}`])
        .single();
      expect(b.data?.status).toBe('sent');
    }, 60_000);

    it('LEAD_UNSUBSCRIBED → enrollment unsubscribed + suppression(unsubscribe) + thread handled', async () => {
      const res = await applySmartleadEvent(admin, {
        event_type: 'LEAD_UNSUBSCRIBED',
        campaign_id: slCampaignId,
        to_email: unsubEmail,
      });
      expect(res.handled).toBe(true);

      const e = await admin
        .from('enrollments')
        .select('status, thread_id')
        .eq('id', enr[unsubEmail])
        .single();
      expect(e.data?.status).toBe('unsubscribed');
      const sup = await admin
        .from('suppression_list')
        .select('reason')
        .eq('organization_id', orgA)
        .eq('email', unsubEmail);
      expect(sup.data?.[0]?.reason).toBe('unsubscribe');
      const thr = await admin.from('threads').select('status').eq('id', e.data?.thread_id).single();
      expect(thr.data?.status).toBe('handled');
    }, 60_000);

    it('EMAIL_COMPLAINT → message complained + suppression(complaint) + enrollment terminal + thread handled; idempotent; arms the breaker', async () => {
      const event = {
        event_type: 'EMAIL_COMPLAINT',
        campaign_id: slCampaignId,
        to_email: complaintEmail,
        message_id: 'c1',
      };
      const res = await applySmartleadEvent(admin, event);
      expect(res.handled).toBe(true);

      const m = await admin
        .from('messages')
        .select('status')
        .eq('enrollment_id', enr[complaintEmail])
        .eq('direction', 'outbound')
        .single();
      expect(m.data?.status).toBe('complained'); // the value the 3.5 breaker counts
      const e = await admin
        .from('enrollments')
        .select('status, thread_id')
        .eq('id', enr[complaintEmail])
        .single();
      expect(e.data?.status).toBe('unsubscribed'); // hard opt-out terminal (halts the sequence)
      const sup = await admin
        .from('suppression_list')
        .select('reason')
        .eq('organization_id', orgA)
        .eq('email', complaintEmail);
      expect(sup.data?.[0]?.reason).toBe('complaint');
      const thr = await admin.from('threads').select('status').eq('id', e.data?.thread_id).single();
      expect(thr.data?.status).toBe('handled');

      // Idempotent: replaying the same complaint webhook is a no-op (still one complained message).
      await applySmartleadEvent(admin, event);
      const again = await admin
        .from('messages')
        .select('id')
        .eq('enrollment_id', enr[complaintEmail])
        .eq('status', 'complained');
      expect((again.data ?? []).length).toBe(1);

      // The breaker is finally ARMED: orgA now has a complaint, so assessHealth breaches (any
      // complaint over max=0). Before 4.1b no inbound event could ever set this — the breaker was dead.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const metrics = await computeOrgHealth(admin, orgA, since);
      expect(metrics.complaints).toBeGreaterThanOrEqual(1);
      const verdict = assessHealth(metrics, {
        maxBounceRate: 0.05,
        minSends: 20,
        maxComplaints: 0,
      });
      expect(verdict.breach).toBe(true);
      expect(verdict.reason).toContain('complaints');
    }, 60_000);

    it('unknown campaign id → handled:false (not ours)', async () => {
      const res = await applySmartleadEvent(admin, {
        event_type: 'EMAIL_REPLY',
        campaign_id: 'sl-camp-does-not-exist',
        to_email: replyEmail,
        message_id: 'x',
      });
      expect(res.handled).toBe(false);
    });

    it.skipIf(!env.SMARTLEAD_WEBHOOK_SECRET)(
      'signed EMAIL_BOUNCE webhook → message+enrollment bounced + suppression(bounce); bad signature → 401',
      async () => {
        const app = Fastify();
        await app.register(webhooksRoute);
        const secret = env.SMARTLEAD_WEBHOOK_SECRET as string;
        const payload = JSON.stringify({
          event_type: 'EMAIL_BOUNCE',
          campaign_id: slCampaignId,
          to_email: bounceEmail,
          message_id: 'b1',
        });
        const sig = `sha256=${createHmac('sha256', secret).update(payload, 'utf8').digest('hex')}`;

        const bad = await app.inject({
          method: 'POST',
          url: '/webhooks/smartlead',
          headers: { 'content-type': 'application/json', 'x-smartlead-signature': 'sha256=nope' },
          payload,
        });
        expect(bad.statusCode).toBe(401);

        const ok = await app.inject({
          method: 'POST',
          url: '/webhooks/smartlead',
          headers: { 'content-type': 'application/json', 'x-smartlead-signature': sig },
          payload,
        });
        expect(ok.statusCode).toBe(200);
        await app.close();

        const m = await admin
          .from('messages')
          .select('status')
          .eq('enrollment_id', enr[bounceEmail])
          .eq('direction', 'outbound')
          .single();
        expect(m.data?.status).toBe('bounced');
        const e = await admin
          .from('enrollments')
          .select('status')
          .eq('id', enr[bounceEmail])
          .single();
        expect(e.data?.status).toBe('bounced');
        const sup = await admin
          .from('suppression_list')
          .select('reason')
          .eq('organization_id', orgA)
          .eq('email', bounceEmail);
        expect(sup.data?.[0]?.reason).toBe('bounce');
      },
      60_000,
    );
  },
);
