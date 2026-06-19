import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getSupabaseAdmin } from '../../db/client.js';
import { recordAutonomyEvent } from '../../lib/autonomy-mode.js';
import { launchCampaign } from '../sending/enroll.js';

// 4.11 — the copilot's WRITE-action registry. Unlike the read-only tools (tools.ts), these change
// product state — so the LLM NEVER executes them. Each action is PROPOSE-ONLY in the chat turn:
// `validate()` is a read-only feasibility check that returns a human title; `execute()` is the real,
// deterministic work and is invoked ONLY by the role-gated confirm route (no LLM in that path).
// Everything runs under the caller's RLS-scoped db (except the autonomy kill-switch, which needs the
// service-role client and is org-pinned to the caller's own org).

export type ActionClass = 'safe' | 'spending' | 'destructive';

export interface CopilotActionCtx {
  /** User-scoped client — RLS scopes every read/write to the caller's org. */
  db: SupabaseClient;
  organizationId: string;
  userId: string;
}

export type ValidateResult = { ok: true; title: string } | { ok: false; reason: string };
export interface ExecuteResult {
  summary: string;
  result: unknown;
}

export interface WriteAction {
  name: string;
  description: string;
  actionClass: ActionClass;
  /** Authoritative gate — the model's args are validated here before validate()/execute() run. */
  argsSchema: z.ZodTypeAny;
  validate(args: unknown, ctx: CopilotActionCtx): Promise<ValidateResult>;
  execute(args: unknown, ctx: CopilotActionCtx): Promise<ExecuteResult>;
}

function defineAction<S extends z.ZodTypeAny>(a: {
  name: string;
  description: string;
  actionClass: ActionClass;
  argsSchema: S;
  validate: (args: z.infer<S>, ctx: CopilotActionCtx) => Promise<ValidateResult>;
  execute: (args: z.infer<S>, ctx: CopilotActionCtx) => Promise<ExecuteResult>;
}): WriteAction {
  return {
    name: a.name,
    description: a.description,
    actionClass: a.actionClass,
    argsSchema: a.argsSchema,
    validate: (args, ctx) => a.validate(args as z.infer<S>, ctx),
    execute: (args, ctx) => a.execute(args as z.infer<S>, ctx),
  };
}

// launch_campaign — DESTRUCTIVE (flips a draft to active + enqueues the dry-run pipeline). Sends stay
// in dry-run regardless: executeSend's two-flag chokepoint is unreachable from here.
const launchCampaignAction = defineAction({
  name: 'launch_campaign',
  description:
    'Launch a DRAFT campaign. Proposes the action for the user to confirm; sends stay in dry-run until go-live.',
  actionClass: 'destructive',
  argsSchema: z.object({ campaignId: z.uuid() }),
  async validate(args, { db }) {
    const c = await db
      .from('campaigns')
      .select('id, name, status')
      .eq('id', args.campaignId)
      .maybeSingle();
    if (c.error) throw c.error;
    if (!c.data) return { ok: false, reason: "I couldn't find that campaign in your workspace." };
    if (c.data.status !== 'draft')
      return {
        ok: false,
        reason: `That campaign is '${c.data.status}', not a draft — only draft campaigns can be launched.`,
      };
    return { ok: true, title: `Launch campaign “${c.data.name}”` };
  },
  async execute(args, { db }) {
    const c = await db
      .from('campaigns')
      .select('id, organization_id, list_id, campaign_type')
      .eq('id', args.campaignId)
      .maybeSingle();
    if (c.error) throw c.error;
    if (!c.data) throw new Error('campaign_not_found');
    const res = await launchCampaign(db, c.data);
    const summary = res.sourceConnected
      ? `Launched — ${res.enrolled} enrolled (dry-run; nothing reaches a real inbox until go-live).`
      : `Kept as a draft — the ${res.source} source isn't connected yet, so no one was enrolled.`;
    return { summary, result: res };
  },
});

// pause_campaign — SAFE (reversible; blocks that campaign's sends).
const pauseCampaignAction = defineAction({
  name: 'pause_campaign',
  description: 'Pause an active campaign (stops its sends; reversible).',
  actionClass: 'safe',
  argsSchema: z.object({ campaignId: z.uuid() }),
  async validate(args, { db }) {
    const c = await db
      .from('campaigns')
      .select('id, name, status')
      .eq('id', args.campaignId)
      .maybeSingle();
    if (c.error) throw c.error;
    if (!c.data) return { ok: false, reason: "I couldn't find that campaign in your workspace." };
    if (c.data.status === 'paused')
      return { ok: false, reason: `“${c.data.name}” is already paused.` };
    return { ok: true, title: `Pause campaign “${c.data.name}”` };
  },
  async execute(args, { db }) {
    const upd = await db
      .from('campaigns')
      .update({ status: 'paused' })
      .eq('id', args.campaignId)
      .select('id, name')
      .maybeSingle();
    if (upd.error) throw upd.error;
    if (!upd.data) throw new Error('campaign_not_found');
    return { summary: `Paused “${upd.data.name}”.`, result: upd.data };
  },
});

// pause_autonomy — SAFE kill-switch (one direction only: on→off). Mirrors POST /autonomy/pause: a
// service-role CAS pinned to the caller's own org, audited in autonomy_events.
const pauseAutonomyAction = defineAction({
  name: 'pause_autonomy',
  description: 'Pause autonomy — the kill-switch that turns off all autonomous sending/replies.',
  actionClass: 'safe',
  argsSchema: z.object({}),
  async validate() {
    return { ok: true, title: 'Pause autonomy (kill-switch)' };
  },
  async execute(_args, { organizationId }) {
    const admin = getSupabaseAdmin();
    if (!admin) throw new Error('service_role_unavailable');
    const cas = await admin
      .from('organizations')
      .update({ autonomy_enabled: false })
      .eq('id', organizationId)
      .eq('autonomy_enabled', true)
      .select('id');
    if (cas.error) throw cas.error;
    const paused = (cas.data ?? []).length > 0;
    if (paused) {
      await recordAutonomyEvent(admin, {
        organizationId,
        kind: 'auto_pause',
        decision: 'auto_pause',
        reason: 'manual_pause',
      });
    }
    return {
      summary: paused ? 'Autonomy paused.' : 'Autonomy was already off — nothing to pause.',
      result: { autonomyEnabled: false, paused },
    };
  },
});

// subscribe_signal — SAFE/reversible (enables future enrollment; no immediate send). Mirrors the
// POST /signals/:id/subscribe guards.
const subscribeSignalAction = defineAction({
  name: 'subscribe_signal',
  description: 'Subscribe a live intent signal to feed an intent_signals campaign.',
  actionClass: 'safe',
  argsSchema: z.object({ signalId: z.uuid(), campaignId: z.uuid() }),
  async validate(args, { db }) {
    const def = await db
      .from('signal_definitions')
      .select('id, name, status')
      .eq('id', args.signalId)
      .maybeSingle();
    if (def.error) throw def.error;
    if (!def.data) return { ok: false, reason: "I couldn't find that signal." };
    if (def.data.status !== 'live')
      return { ok: false, reason: `“${def.data.name}” isn't available yet.` };
    const camp = await db
      .from('campaigns')
      .select('id, name, campaign_type')
      .eq('id', args.campaignId)
      .maybeSingle();
    if (camp.error) throw camp.error;
    if (!camp.data) return { ok: false, reason: "I couldn't find that campaign." };
    if (camp.data.campaign_type !== 'intent_signals')
      return { ok: false, reason: 'Signals can only feed an intent_signals campaign.' };
    return { ok: true, title: `Subscribe “${def.data.name}” → “${camp.data.name}”` };
  },
  async execute(args, { db, organizationId }) {
    const up = await db
      .from('signal_subscriptions')
      .upsert(
        {
          organization_id: organizationId,
          signal_definition_id: args.signalId,
          campaign_id: args.campaignId,
          active: true,
        },
        { onConflict: 'organization_id,signal_definition_id' },
      )
      .select('signal_definition_id, campaign_id, active')
      .single();
    if (up.error) throw up.error;
    return { summary: 'Signal subscribed — leads will enroll as it fires.', result: up.data };
  },
});

// create_list — SAFE (an empty list; no spend until a campaign launches over it).
const createListAction = defineAction({
  name: 'create_list',
  description: 'Create a new (empty) lead list.',
  actionClass: 'safe',
  argsSchema: z.object({
    name: z.string().min(1).max(200),
    entityType: z.enum(['person', 'company', 'local_business']),
    description: z.string().max(2000).optional(),
  }),
  async validate(args) {
    return { ok: true, title: `Create list “${args.name}”` };
  },
  async execute(args, { db, organizationId }) {
    const ins = await db
      .from('lists')
      .insert({
        organization_id: organizationId,
        name: args.name,
        entity_type: args.entityType,
        description: args.description,
      })
      .select('*')
      .single();
    if (ins.error) throw ins.error;
    return { summary: `Created list “${args.name}”.`, result: ins.data };
  },
});

export const WRITE_ACTIONS: Record<string, WriteAction> = {
  launch_campaign: launchCampaignAction,
  pause_campaign: pauseCampaignAction,
  pause_autonomy: pauseAutonomyAction,
  subscribe_signal: subscribeSignalAction,
  create_list: createListAction,
};

export const WRITE_ACTION_NAMES = Object.keys(WRITE_ACTIONS);

/** Write actions require an elevated role at BOTH propose and confirm (scoped tool permissions, §13). */
export const WRITE_ACTION_ROLES = ['owner', 'admin'] as const;
