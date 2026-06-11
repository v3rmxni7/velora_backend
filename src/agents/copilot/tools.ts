import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { icpSuggestions } from '../leads/icp.js';

// The copilot's tool registry. Every tool is READ-ONLY and runs under ctx.db — the per-request
// user-scoped (JWT) client — so RLS + auth_organization_id() scope every read to the caller's org.
// A tool physically cannot read another org's rows, no matter what the model asks. No tool writes,
// enqueues, or spends (suggest_icp's single capped Haiku call via icpSuggestions is the one
// allowed model spend). Write/action tools stay deferred to Phase 4.

export interface CopilotToolCtx {
  /** User-scoped Supabase client — RLS scopes every query to the caller's organization. */
  db: SupabaseClient;
  organizationId: string;
}

export interface CopilotTool {
  name: string;
  description: string;
  /** Authoritative gate — model args are validated here before run() is ever called. */
  argsSchema: z.ZodTypeAny;
  run(args: unknown, ctx: CopilotToolCtx): Promise<unknown>;
}

/** Type-safe tool definition: run() receives args already inferred from argsSchema. */
function defineTool<S extends z.ZodTypeAny>(t: {
  name: string;
  description: string;
  argsSchema: S;
  run: (args: z.infer<S>, ctx: CopilotToolCtx) => Promise<unknown>;
}): CopilotTool {
  return {
    name: t.name,
    description: t.description,
    argsSchema: t.argsSchema,
    run: (args, ctx) => t.run(args as z.infer<S>, ctx),
  };
}

const ENTITY = z.enum(['person', 'company', 'local_business']);
const TABLE = {
  person: 'people',
  company: 'companies',
  local_business: 'local_businesses',
} as const;
const NAME_COL = { person: 'full_name', company: 'name', local_business: 'name' } as const;

// suggest_icp — propose ICP lead searches from the org's KB. Wraps icpSuggestions().
const suggestIcp = defineTool({
  name: 'suggest_icp',
  description: "Suggest ideal-customer-profile lead searches from the org's knowledge base.",
  argsSchema: z.object({}), // no args; unknown keys stripped (forgiving)
  async run(_args, { db }) {
    const [cp, pi] = await Promise.all([
      db.from('coaching_points').select('content').limit(40),
      db.from('proof_items').select('title, body').limit(40),
    ]);
    if (cp.error) throw cp.error;
    if (pi.error) throw pi.error;
    const coachingPoints = (cp.data ?? []).map((r) => String(r.content));
    const proofItems = (pi.data ?? []).map((r) => [r.title, r.body].filter(Boolean).join(' — '));
    const suggestions = await icpSuggestions({ coachingPoints, proofItems });
    return { suggestions };
  },
});

// summarize_kb — read the org's knowledge base for the responder to summarize. No embed/spend.
const summarizeKb = defineTool({
  name: 'summarize_kb',
  description: "Read a summary of the org's knowledge base (coaching points, proof, documents).",
  argsSchema: z.object({}),
  async run(_args, { db }) {
    const [cp, pi, docs] = await Promise.all([
      db.from('coaching_points').select('content').limit(40),
      db.from('proof_items').select('category, title, body').limit(40),
      db.from('kb_documents').select('title, status').limit(40),
    ]);
    if (cp.error) throw cp.error;
    if (pi.error) throw pi.error;
    if (docs.error) throw docs.error;
    return {
      coachingPoints: (cp.data ?? []).map((r) => String(r.content)),
      proofItems: (pi.data ?? []).map((r) => ({
        category: r.category,
        title: r.title,
        body: r.body,
      })),
      documents: (docs.data ?? []).map((r) => ({ title: r.title, status: r.status })),
    };
  },
});

// list_leads — list the org's saved leads (mirrors GET /leads). Capped at 25.
const listLeads = defineTool({
  name: 'list_leads',
  description:
    'List the org\'s saved leads by entity type ("person" | "company" | "local_business"), optional name search.',
  argsSchema: z.object({
    entityType: ENTITY,
    search: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(25).default(10),
  }),
  async run(args, { db }) {
    let query = db.from(TABLE[args.entityType]).select('*');
    if (args.search) query = query.ilike(NAME_COL[args.entityType], `%${args.search}%`);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(args.limit);
    if (error) throw error;
    return { entityType: args.entityType, rows: data ?? [] };
  },
});

// list_lists — list the org's saved lead lists (mirrors GET /lists).
const listLists = defineTool({
  name: 'list_lists',
  description: "List the org's saved lead lists.",
  argsSchema: z.object({}),
  async run(_args, { db }) {
    const { data, error } = await db
      .from('lists')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { lists: data ?? [] };
  },
});

export const COPILOT_TOOLS: Record<string, CopilotTool> = {
  suggest_icp: suggestIcp,
  summarize_kb: summarizeKb,
  list_leads: listLeads,
  list_lists: listLists,
};

// ---- Suggested actions: deterministic, account-state-driven nudges (no LLM call) ----

export interface AccountCounts {
  kbDocuments: number;
  coachingPoints: number;
  proofItems: number;
  leads: number; // people + companies + local_businesses
  lists: number;
  tasks: number;
}
export interface SuggestedAction {
  label: string;
  /** A ready-to-send copilot message the UI can fire on click. */
  prompt: string;
}

/** Pure rule function — the next useful action given the org's data state. */
export function suggestActions(c: AccountCounts): SuggestedAction[] {
  const hasKb = c.kbDocuments > 0 || c.coachingPoints > 0 || c.proofItems > 0;
  if (!hasKb) {
    return [{ label: 'Set up your knowledge base', prompt: 'How do I set up my knowledge base?' }];
  }
  if (c.leads === 0) {
    return [
      { label: 'Find your first leads', prompt: 'suggest ICP personas from my knowledge base' },
    ];
  }
  if (c.lists === 0) {
    return [{ label: 'Organize leads into a list', prompt: 'list my leads' }];
  }
  if (c.tasks === 0) {
    return [{ label: 'Generate a grounded draft', prompt: 'list my leads' }];
  }
  return [{ label: 'Suggest ICP personas from my KB', prompt: 'suggest ICP personas' }];
}
