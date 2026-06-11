import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { complete, type ProviderRegistry } from '../llm/complete.js';
import type { LLMMessage } from '../llm/types.js';
import { COPILOT_TOOLS } from './tools.js';

// Conversation cost discipline (Slice 4): replay only the last MAX_HISTORY turns, cap the tool
// result fed back to the model, and cap output. Model is copilot → claude-haiku-4-5 (TASK_MODEL_MAP).
export const MAX_HISTORY = 12;
const RESULT_CAP = 4000; // chars of tool result handed to the responder
const TOOL_ENUM = ['suggest_icp', 'summarize_kb', 'list_leads', 'list_lists'] as const;

// The planner's structured output. AUTHORITATIVE: the model's tool choice + args are validated
// here (and per-tool below) before anything runs — the model is never trusted (Slice-2 discipline).
export const CopilotPlanSchema = z
  .object({
    action: z.enum(['reply', 'tool']),
    reply: z.string().optional(),
    tool: z.enum(TOOL_ENUM).optional(),
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
    tool: { type: 'string', enum: [...TOOL_ENUM] },
    args: { type: 'string' }, // JSON-encoded arguments for the chosen tool
  },
  required: ['action'],
};

const TOOL_LINES = Object.values(COPILOT_TOOLS)
  .map((t) => `- ${t.name}: ${t.description}`)
  .join('\n');

const PLANNER_SYSTEM = [
  "You are Velora's assistant for a B2B sales team. You either reply directly or call ONE read-only tool to fetch the user's own data.",
  'Available tools:',
  TOOL_LINES,
  'If the request maps to a tool, set action="tool", tool to its name, and "args" to a JSON STRING of the arguments (e.g. "{\\"entityType\\":\\"person\\"}"); use "{}" when the tool needs no arguments. Otherwise set action="reply" with a helpful answer.',
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
  history: LLMMessage[];
  userMessage: string;
}
export interface CopilotTurnResult {
  replyText: string;
  toolCall?: { name: string; args: unknown; result: unknown };
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

  const tool = plan.tool ? COPILOT_TOOLS[plan.tool] : undefined;
  if (!tool) {
    return { replyText: "I can't do that yet." };
  }

  // Model args arrive as a JSON string; parse then validate against the tool's own schema
  // (model args are NOT trusted) before running it.
  let rawArgs: unknown = {};
  if (plan.args) {
    try {
      rawArgs = JSON.parse(plan.args);
    } catch {
      rawArgs = {};
    }
  }
  const argsParsed = tool.argsSchema.safeParse(rawArgs);
  let result: unknown;
  if (!argsParsed.success) {
    result = { error: 'invalid args', issues: argsParsed.error.issues };
  } else {
    result = await tool.run(argsParsed.data, {
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
          content: `[${tool.name} result]\n${JSON.stringify(result).slice(0, RESULT_CAP)}`,
        },
      ],
      maxOutputTokens: 500,
    },
    reg,
  );

  return {
    replyText: respRes.text.trim() || FALLBACK_REPLY,
    toolCall: {
      name: tool.name,
      args: argsParsed.success ? argsParsed.data : rawArgs,
      result,
    },
  };
}
