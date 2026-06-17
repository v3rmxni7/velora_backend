import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextFollowupDue } from '../agents/sending/followup.js';
import { campaignsRoute } from '../api/routes/campaigns.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB, routes via app.inject + real JWTs. Proves Slice 4.3a: sequences are
// authorable (PUT replaces → contiguous steps the EXISTING sequencer sees), draft-only locking,
// type-aware launch (cold enrolls; non-cold honestly reports source-not-connected, no fake audience),
// and cross-tenant denial. No LLM, no Smartlead, no real email.
const ready =
  process.env.RUN_DB_IT === '1' &&
  !!env.SUPABASE_URL &&
  !!env.SUPABASE_ANON_KEY &&
  !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const ANON = env.SUPABASE_ANON_KEY ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

interface Acct {
  orgId: string;
  userId: string;
  email: string;
  token: string;
}

describe.skipIf(!ready)(
  'Slice 4.3a — campaign builder depth (authoring + type-aware launch)',
  () => {
    const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anon = createClient(SUPABASE_URL, ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const stamp = Date.now();
    const a: Acct = { orgId: '', userId: '', email: `cb-a+${stamp}@example.com`, token: '' };
    const b: Acct = { orgId: '', userId: '', email: `cb-b+${stamp}@example.com`, token: '' };
    let coldId = '';
    let warmId = '';
    let listId = '';

    async function makeAcct(o: Acct, tag: string) {
      const org = await admin
        .from('organizations')
        .insert({ name: `cb-${tag}-${stamp}` })
        .select('id')
        .single();
      if (org.error) throw org.error;
      o.orgId = org.data.id as string;
      const pwd = `Test-${stamp}-pw!`;
      const created = await admin.auth.admin.createUser({
        email: o.email,
        password: pwd,
        email_confirm: true,
      });
      if (created.error || !created.data.user) throw created.error ?? new Error('createUser');
      o.userId = created.data.user.id;
      await admin
        .from('users')
        .insert({ id: o.userId, organization_id: o.orgId, email: o.email, role: 'owner' });
      const signin = await anon.auth.signInWithPassword({ email: o.email, password: pwd });
      if (signin.error || !signin.data.session) throw signin.error ?? new Error('signin');
      o.token = signin.data.session.access_token;
    }

    async function inject(method: 'POST' | 'PUT', url: string, token: string, payload?: unknown) {
      const app = Fastify();
      await app.register(campaignsRoute);
      // Only attach a body (and let inject set content-type) when there IS one — a no-body POST with
      // content-type:application/json trips Fastify's empty-body 400.
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
      await makeAcct(a, 'a');
      await makeAcct(b, 'b');
      // Org A: a list with 2 person leads + a cold (draft, list) + a warm (draft, no list) campaign.
      const list = await admin
        .from('lists')
        .insert({ organization_id: a.orgId, name: 'CB list', entity_type: 'person' })
        .select('id')
        .single();
      if (list.error) throw list.error;
      listId = list.data.id as string;
      for (let i = 0; i < 2; i++) {
        const p = await admin
          .from('people')
          .insert({
            organization_id: a.orgId,
            provider: 'seed',
            external_id: `cb:${i}:${stamp}`,
            full_name: `Lead ${i}`,
            email: `cb${i}+${stamp}@x.com`,
            source: 'find_leads',
          })
          .select('id')
          .single();
        if (p.error) throw p.error;
        const lm = await admin.from('list_members').insert({
          organization_id: a.orgId,
          list_id: listId,
          entity_type: 'person',
          entity_id: p.data.id,
        });
        if (lm.error) throw lm.error;
      }
      const cold = await admin
        .from('campaigns')
        .insert({
          organization_id: a.orgId,
          name: 'Cold',
          campaign_type: 'cold_outbound',
          status: 'draft',
          list_id: listId,
        })
        .select('id')
        .single();
      if (cold.error) throw cold.error;
      coldId = cold.data.id as string;
      const warm = await admin
        .from('campaigns')
        .insert({
          organization_id: a.orgId,
          name: 'Warm',
          campaign_type: 'warm_outbound',
          status: 'draft',
        })
        .select('id')
        .single();
      if (warm.error) throw warm.error;
      warmId = warm.data.id as string;
    }, 180_000);

    afterAll(async () => {
      if (a.orgId) await admin.from('organizations').delete().eq('id', a.orgId);
      if (b.orgId) await admin.from('organizations').delete().eq('id', b.orgId);
      if (a.userId) await admin.auth.admin.deleteUser(a.userId);
      if (b.userId) await admin.auth.admin.deleteUser(b.userId);
    });

    it('PUT /campaigns/:id/steps replaces the sequence with contiguous step_numbers 1..N', async () => {
      const res = await inject('PUT', `/campaigns/${coldId}/steps`, a.token, {
        steps: [
          { delayDays: 0, bodyMode: 'ai_grounded' },
          { delayDays: 3, bodyMode: 'ai_grounded', subjectTemplate: 'Re: following up' },
          { delayDays: 7, bodyMode: 'template' },
        ],
      });
      expect(res.statusCode).toBe(200);
      const steps = await admin
        .from('campaign_steps')
        .select('step_number, delay_days, body_mode')
        .eq('campaign_id', coldId)
        .order('step_number', { ascending: true });
      expect((steps.data ?? []).map((s) => s.step_number)).toEqual([1, 2, 3]);
      expect(steps.data?.[1]?.delay_days).toBe(3);
      expect(steps.data?.[2]?.body_mode).toBe('template');
    }, 60_000);

    it('the authored step 2 is visible to the EXISTING sequencer (nextFollowupDue)', async () => {
      // Seed a 'sent' enrollment at step 1; the sequencer's due-check should find authored step 2.
      const lead = await admin
        .from('people')
        .insert({
          organization_id: a.orgId,
          provider: 'seed',
          external_id: `cb-seq:${stamp}`,
          full_name: 'Seq',
          email: `seq+${stamp}@x.com`,
          source: 'find_leads',
        })
        .select('id')
        .single();
      if (lead.error) throw lead.error;
      const enr = await admin
        .from('enrollments')
        .insert({
          organization_id: a.orgId,
          campaign_id: coldId,
          lead_type: 'person',
          lead_id: lead.data.id,
          status: 'sent',
          current_step: 1,
        })
        .select('id')
        .single();
      if (enr.error) throw enr.error;
      const due = await nextFollowupDue(admin, enr.data.id as string);
      expect(due?.nextStep).toBe(2);
    }, 60_000);

    it('cold launch enrolls the list + goes active (sourceConnected); then steps are locked (422)', async () => {
      const launch = await inject('POST', `/campaigns/${coldId}/launch`, a.token);
      expect(launch.statusCode).toBe(200);
      const { data } = launch.json() as {
        data: { enrolled: number; sourceConnected: boolean; source: string };
      };
      expect(data.sourceConnected).toBe(true);
      expect(data.source).toBe('list');
      expect(data.enrolled).toBeGreaterThanOrEqual(2);
      const c = await admin.from('campaigns').select('status').eq('id', coldId).single();
      expect(c.data?.status).toBe('active');

      // Draft-only: editing the now-active campaign's sequence is locked.
      const locked = await inject('PUT', `/campaigns/${coldId}/steps`, a.token, {
        steps: [{ delayDays: 0, bodyMode: 'ai_grounded' }],
      });
      expect(locked.statusCode).toBe(422);
      expect(locked.json()).toMatchObject({ error: 'sequence_locked' });
    }, 60_000);

    it('non-cold launch (warm) → source not connected, enrolls nothing, stays draft (no fake audience)', async () => {
      const launch = await inject('POST', `/campaigns/${warmId}/launch`, a.token);
      expect(launch.statusCode).toBe(200);
      const { data } = launch.json() as {
        data: { enrolled: number; sourceConnected: boolean; source: string };
      };
      expect(data.sourceConnected).toBe(false);
      expect(data.source).toBe('crm');
      expect(data.enrolled).toBe(0);
      const c = await admin.from('campaigns').select('status').eq('id', warmId).single();
      expect(c.data?.status).toBe('draft'); // never went active
      const enr = await admin.from('enrollments').select('id').eq('campaign_id', warmId);
      expect((enr.data ?? []).length).toBe(0); // no fabricated enrollments
    }, 60_000);

    it('cross-tenant: org B cannot author org A’s campaign steps (404)', async () => {
      const res = await inject('PUT', `/campaigns/${coldId}/steps`, b.token, {
        steps: [{ delayDays: 0, bodyMode: 'ai_grounded' }],
      });
      expect(res.statusCode).toBe(404);
    }, 60_000);
  },
);
