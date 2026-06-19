import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { assembleBrief, type CallRecord } from '../../agents/calls/brief.js';
import { CALL_OUTCOMES } from '../../lib/analytics.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

// Phase 4 Slice 4.9 — the Dialer surface (SPEC §3.7). The agent does NOT call: it queues leads,
// generates a brief on read, and a rep manually logs the outcome. "Call" is a tel: link (FE). All
// user-scoped (the calls RLS quartet); reps own their queue/log. No send path, no credit debit.
const LEAD_TABLE = {
  person: 'people',
  company: 'companies',
  local_business: 'local_businesses',
} as const;
type LeadType = keyof typeof LEAD_TABLE;

const TabQuery = z.object({ tab: z.enum(['ready', 'upcoming', 'log']).default('ready') });
const IdParam = z.object({ id: z.uuid() });
const AddCall = z.object({
  leadType: z.enum(['person', 'company', 'local_business']),
  leadId: z.uuid(),
  // Must be an ISO datetime — a non-date string would otherwise reach the timestamptz insert and 500
  // with a Postgres 22007 instead of a clean 400 (audit S5).
  scheduledAt: z.iso.datetime().optional(),
  phone: z.string().max(40).optional(),
});
const LogCall = z.object({
  outcome: z.enum(CALL_OUTCOMES),
  notes: z.string().max(2000).optional(),
});

const CALL_COLS =
  'id, lead_type, lead_id, thread_id, campaign_id, phone, status, outcome, notes, scheduled_at, logged_by, called_at, created_at';

export const dialerRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // The queue/log, split by tab (status + scheduled_at). Each row carries the lead's name for display.
  app.get('/dialer/calls', async (request) => {
    const { db } = requireAuth(request);
    const { tab } = TabQuery.parse(request.query);
    const nowIso = new Date().toISOString();
    let q = db.from('calls').select(CALL_COLS);
    if (tab === 'ready') {
      q = q
        .in('status', ['queued', 'scheduled'])
        .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
        .order('created_at', { ascending: false });
    } else if (tab === 'upcoming') {
      q = q
        .in('status', ['queued', 'scheduled'])
        .gt('scheduled_at', nowIso)
        .order('scheduled_at', { ascending: true });
    } else {
      q = q.eq('status', 'logged').order('called_at', { ascending: false });
    }
    const { data, error } = await q;
    if (error) throw error;
    const calls = (data ?? []) as { lead_type: LeadType; lead_id: string }[];

    // Resolve lead names (batched per type; RLS-scoped). person → full_name, others → name.
    const names = new Map<string, string | null>();
    for (const type of ['person', 'company', 'local_business'] as LeadType[]) {
      const ids = [...new Set(calls.filter((c) => c.lead_type === type).map((c) => c.lead_id))];
      if (ids.length === 0) continue;
      const nameCol = type === 'person' ? 'full_name' : 'name';
      const r = await db.from(LEAD_TABLE[type]).select(`id, ${nameCol}`).in('id', ids);
      if (r.error) throw r.error;
      for (const row of r.data ?? []) {
        names.set(`${type}:${row.id}`, (row as Record<string, unknown>)[nameCol] as string | null);
      }
    }
    return {
      data: (calls as Record<string, unknown>[]).map((c) => ({
        ...c,
        leadName: names.get(`${c.lead_type}:${c.lead_id}`) ?? null,
      })),
    };
  });

  // Add a lead to the dialer queue. Idempotent: an existing OPEN call for the lead is returned (not
  // duplicated). Resolves the phone (rep-typed > people/local_businesses on file) + snapshots it; a
  // rep-typed phone for a person is written back to people.phone (so the tel: link works).
  app.post('/dialer/calls', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const body = AddCall.parse(request.body);

    const open = await db
      .from('calls')
      .select(CALL_COLS)
      .eq('lead_type', body.leadType)
      .eq('lead_id', body.leadId)
      .in('status', ['queued', 'scheduled'])
      .maybeSingle();
    if (open.error) throw open.error;
    if (open.data) return { data: open.data }; // idempotent — already queued

    // Validate the lead is the caller's org (RLS read) + resolve a phone on file.
    const wantsPhone = body.leadType === 'person' || body.leadType === 'local_business';
    const leadRow = await db
      .from(LEAD_TABLE[body.leadType])
      .select(wantsPhone ? 'id, phone' : 'id')
      .eq('id', body.leadId)
      .maybeSingle();
    if (leadRow.error) throw leadRow.error;
    if (!leadRow.data) return reply.code(404).send({ error: 'lead_not_found' });
    const onFile = (leadRow.data as { phone?: string | null }).phone ?? null;
    const phone = body.phone?.trim() || onFile;
    if (body.phone?.trim() && body.leadType === 'person') {
      await db.from('people').update({ phone: body.phone.trim() }).eq('id', body.leadId);
    }

    const latestThread = await db
      .from('threads')
      .select('id')
      .eq('lead_type', body.leadType)
      .eq('lead_id', body.leadId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const scheduled = !!body.scheduledAt && Date.parse(body.scheduledAt) > Date.now();
    const ins = await db
      .from('calls')
      .insert({
        organization_id: organizationId,
        lead_type: body.leadType,
        lead_id: body.leadId,
        thread_id: latestThread.data?.id ?? null,
        phone,
        status: scheduled ? 'scheduled' : 'queued',
        // Only store a future scheduled_at; a past/absent date is a plain 'queued' call (keeps the
        // stored timestamp consistent with the status — no past "scheduled" rows).
        scheduled_at: scheduled ? body.scheduledAt : null,
      })
      .select(CALL_COLS)
      .single();
    if (ins.error) {
      // A concurrent add lost the race on the partial unique index → return the winner (idempotent).
      if (ins.error.code === '23505') {
        const ex = await db
          .from('calls')
          .select(CALL_COLS)
          .eq('lead_type', body.leadType)
          .eq('lead_id', body.leadId)
          .in('status', ['queued', 'scheduled'])
          .maybeSingle();
        if (ex.data) return { data: ex.data };
      }
      throw ins.error;
    }
    return reply.code(201).send({ data: ins.data });
  });

  // The brief — assembled on read from REAL data (lead + threads + grounding), no LLM, never 500s.
  app.get('/dialer/calls/:id/brief', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const call = await db.from('calls').select('*').eq('id', id).maybeSingle();
    if (call.error) throw call.error;
    if (!call.data) return reply.code(404).send({ error: 'not_found' });
    return { data: await assembleBrief(db, organizationId, call.data as CallRecord) };
  });

  app.post('/dialer/calls/:id/skip', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const upd = await db
      .from('calls')
      .update({ status: 'skipped' })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (upd.error) throw upd.error;
    if (!upd.data) return reply.code(404).send({ error: 'not_found' });
    return { data: { id, status: 'skipped' } };
  });

  // Log a HUMAN call outcome. logged_by is the JWT user (server-side, never the body).
  app.post('/dialer/calls/:id/log', async (request, reply) => {
    const { db, userId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { outcome, notes } = LogCall.parse(request.body);
    const upd = await db
      .from('calls')
      .update({
        status: 'logged',
        outcome,
        notes: notes ?? null,
        called_at: new Date().toISOString(),
        logged_by: userId,
      })
      .eq('id', id)
      .select(CALL_COLS)
      .maybeSingle();
    if (upd.error) throw upd.error;
    if (!upd.data) return reply.code(404).send({ error: 'not_found' });
    return { data: upd.data };
  });
};
