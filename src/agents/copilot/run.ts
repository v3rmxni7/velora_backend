import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { complete, type ProviderRegistry } from '../llm/complete.js';
import type { LLMMessage } from '../llm/types.js';
import { WRITE_ACTION_NAMES, WRITE_ACTION_ROLES, WRITE_ACTIONS } from './actions.js';
import { COPILOT_TOOLS } from './tools.js';

// Conversation cost discipline (Slice 4): replay only the last MAX_HISTORY turns, cap the tool
// result fed back to the model, and cap output. Model is copilot → claude-haiku-4-5 (TASK_MODEL_MAP).
export const MAX_HISTORY = 12;
const RESULT_CAP = 4000; // chars of tool result handed to the responder
// Read tools (tools.ts) fetch the user's own data; write actions (actions.ts) change state and are
// PROPOSE-ONLY — the planner may pick one, but it's never executed here; it returns a proposal the
// user confirms. `tool` is a free string validated against both registries in dispatch.
const ALL_TOOL_NAMES = [...Object.keys(COPILOT_TOOLS), ...WRITE_ACTION_NAMES];

// The planner's structured output. AUTHORITATIVE: the model's tool choice + args are validated
// here (and per-tool below) before anything runs — the model is never trusted (Slice-2 discipline).
export const CopilotPlanSchema = z
  .object({
    action: z.enum(['reply', 'tool']),
    reply: z.string().optional(),
    tool: z.string().optional(),
    args: z.string().optional(), // JSON-encoded tool arguments (Anthropic schemas can't express a free-form object)
  })
  .strict();
export type CopilotPlan = z.infer<typeof CopilotPlanSchema>;

// JSON Schema handed to the model — types + enums only (Anthropic rejects length/maxItems
// keywords; Zod above + per-tool schemas enforce the real constraints).
const PLANNER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['reply', 'tool'] },
    reply: { type: 'string' },
    tool: { type: 'string', enum: ALL_TOOL_NAMES },
    args: { type: 'string' }, // JSON-encoded arguments for the chosen tool
  },
  required: ['action'],
};

const TOOL_LINES = [
  ...Object.values(COPILOT_TOOLS).map((t) => `- ${t.name}: ${t.description}`),
  ...Object.values(WRITE_ACTIONS).map(
    (a) => `- ${a.name}: ${a.description} (ACTION — you propose; the user confirms)`,
  ),
].join('\n');

const PLANNER_SYSTEM = [
  "You are Velora's assistant for a B2B sales team. You either reply directly, call ONE read-only tool to fetch the user's own data, or PROPOSE ONE action.",
  'Available tools and actions:',
  TOOL_LINES,
  'If the request maps to a tool or action, set action="tool", tool to its name, and "args" to a JSON STRING of the arguments (e.g. "{\\"entityType\\":\\"person\\"}"); use "{}" when none are needed. Otherwise set action="reply" with a helpful answer.',
  'ACTIONS (launch_campaign, pause_campaign, pause_autonomy, subscribe_signal, create_list) change account state — you only PROPOSE them; the user must confirm before anything happens. Never claim an action was already done.',
  "Never invent data about the user's leads or knowledge base — to state anything specific you MUST call a tool. Return only JSON.",
].join('\n');

const RESPONDER_SYSTEM =
  "You are Velora's assistant. Answer the user concisely using ONLY the provided tool result. Do not invent any data beyond it. If the result is an error, briefly say so and ask the user to clarify.";

const FALLBACK_REPLY =
  "I'm not sure how to help with that. Try asking me to suggest ICP personas, summarize your knowledge base, or list your leads or lists.";

export interface CopilotTurnInput {
  /** User-scoped client — passed straight to tools so every read is RLS-scoped to the org. */
  db: SupabaseClient;
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  history: LLMMessage[];
  userMessage: string;
}
export interface CopilotTurnResult {
  replyText: string;
  toolCall?: { name: string; args: unknown; result: unknown };
  /** Set when the planner PROPOSED a write action — the route persists it as a copilot_actions row. */
  proposedAction?: { kind: string; actionClass: string; title: string; args: unknown };
}

function parsePlan(text: string): CopilotPlan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = CopilotPlanSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * One copilot turn: planner (which tool / reply) → validate → run read-only tool → responder.
 * Plain chat = 1 Haiku call; a tool turn = 2 (planner + responder). `reg` is an injectable
 * registry (default getRegistry()) — the same failover-test seam the other agents use.
 */
export async function runCopilotTurn(
  input: CopilotTurnInput,
  reg?: ProviderRegistry,
): Promise<CopilotTurnResult> {
  const history = input.history.slice(-MAX_HISTORY);
  const userMsg: LLMMessage = { role: 'user', content: input.userMessage };

  const planRes = await complete(
    'copilot',
    {
      system: PLANNER_SYSTEM,
      messages: [...history, userMsg],
      jsonSchema: PLANNER_JSON_SCHEMA,
      maxOutputTokens: 250,
    },
    reg,
  );

  const plan = parsePlan(planRes.text);

  // Plain reply, or unparseable / unknown plan → a conversational answer, no tool runs.
  if (!plan || plan.action === 'reply') {
    return { replyText: plan?.reply?.trim() || FALLBACK_REPLY };
  }

  // Model args arrive as a JSON string; parse once, then validate against the chosen tool/action's
  // own schema (model args are NOT trusted) before running anything.
  let rawArgs: unknown = {};
  if (plan.args) {
    try {
      rawArgs = JSON.parse(plan.args);
    } catch {
      rawArgs = {};
    }
  }

  const readTool = plan.tool ? COPILOT_TOOLS[plan.tool] : undefined;
  const writeAction = plan.tool ? WRITE_ACTIONS[plan.tool] : undefined;

  // ---- WRITE ACTION: PROPOSE-ONLY. The LLM never executes; nothing is mutated here. We validate
  // feasibility, then return a proposal the route persists + the user confirms via a deterministic,
  // role-gated endpoint.
  if (writeAction) {
    // Scoped permissions (§13): only owners/admins may propose an action.
    if (!WRITE_ACTION_ROLES.includes(input.role as (typeof WRITE_ACTION_ROLES)[number])) {
      return {
        replyText:
          'That action changes account settings, so it needs an owner or admin — ask a teammate with the right role to run it.',
      };
    }
    const ctx = { db: input.db, organizationId: input.organizationId, userId: input.userId };
    const parsed = writeAction.argsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        replyText:
          "I couldn't get the details I need for that — could you say which campaign, list, or signal you mean?",
      };
    }
    const check = await writeAction.validate(parsed.data, ctx);
    if (!check.ok) return { replyText: check.reason };
    // A proposal — NOTHING is mutated. The route writes a copilot_actions row; the UI shows a card.
    return {
      replyText: `${check.title} — review and confirm below before anything happens.`,
      toolCall: {
        name: writeAction.name,
        args: parsed.data,
        result: {
          proposed: true,
          action: {
            kind: writeAction.name,
            actionClass: writeAction.actionClass,
            title: check.title,
          },
        },
      },
      proposedAction: {
        kind: writeAction.name,
        actionClass: writeAction.actionClass,
        title: check.title,
        args: parsed.data,
      },
    };
  }

  // ---- READ TOOL: fetch + summarize.
  if (!readTool) {
    return { replyText: "I can't do that yet." };
  }
  const argsParsed = readTool.argsSchema.safeParse(rawArgs);
  let result: unknown;
  if (!argsParsed.success) {
    result = { error: 'invalid args', issues: argsParsed.error.issues };
  } else {
    result = await readTool.run(argsParsed.data, {
      db: input.db,
      organizationId: input.organizationId,
    });
  }

  const respRes = await complete(
    'copilot',
    {
      system: RESPONDER_SYSTEM,
      messages: [
        ...history,
        userMsg,
        {
          role: 'user',
          content: `[${readTool.name} result]\n${JSON.stringify(result).slice(0, RESULT_CAP)}`,
        },
      ],
      maxOutputTokens: 500,
    },
    reg,
  );

  return {
    replyText: respRes.text.trim() || FALLBACK_REPLY,
    toolCall: {
      name: readTool.name,
      args: argsParsed.success ? argsParsed.data : rawArgs,
      result,
    },
  };
}
