import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { ProviderRegistry } from '../llm/complete.js';
import type { LLMProvider } from '../llm/provider.js';
import { CopilotPlanSchema, runCopilotTurn } from './run.js';
import { type AccountCounts, suggestActions } from './tools.js';

// A fake provider: returns the given planner JSON for the structured (planner) call, and a
// canned reply for the unstructured (responder) call. No network — pure, deterministic.
function fakeReg(plannerJson: string): ProviderRegistry {
  const provider: LLMProvider = {
    id: 'anthropic',
    async generate(req) {
      const isPlanner = Boolean(req.jsonSchema);
      return {
        text: isPlanner ? plannerJson : 'RESPONDER_REPLY',
        model: 'claude-haiku-4-5',
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
  return { anthropic: provider };
}

// A db that throws if touched — proves a code path never reached the data layer.
const throwingDb = new Proxy(
  {},
  {
    get() {
      throw new Error('db must not be touched on this path');
    },
  },
) as unknown as SupabaseClient;

describe('CopilotPlanSchema (authoritative — model output is not trusted)', () => {
  it('accepts a valid reply plan', () => {
    expect(CopilotPlanSchema.safeParse({ action: 'reply', reply: 'hi' }).success).toBe(true);
  });

  it('accepts a valid tool plan', () => {
    const r = CopilotPlanSchema.safeParse({
      action: 'tool',
      tool: 'list_leads',
      args: '{"entityType":"person"}',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown tool name', () => {
    expect(CopilotPlanSchema.safeParse({ action: 'tool', tool: 'delete_everything' }).success).toBe(
      false,
    );
  });

  it('rejects an invalid action', () => {
    expect(CopilotPlanSchema.safeParse({ action: 'destroy' }).success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(CopilotPlanSchema.safeParse({ action: 'reply', evil: true }).success).toBe(false);
  });
});

describe('runCopilotTurn', () => {
  it('reply path: returns the planner reply and never touches the db (1 call, no tool)', async () => {
    const turn = await runCopilotTurn(
      { db: throwingDb, organizationId: 'org', history: [], userMessage: 'hello' },
      fakeReg(JSON.stringify({ action: 'reply', reply: 'Hello! How can I help?' })),
    );
    expect(turn.replyText).toBe('Hello! How can I help?');
    expect(turn.toolCall).toBeUndefined();
  });

  it('unparseable planner output → safe fallback reply, no tool', async () => {
    const turn = await runCopilotTurn(
      { db: throwingDb, organizationId: 'org', history: [], userMessage: 'hi' },
      fakeReg('not json at all'),
    );
    expect(turn.toolCall).toBeUndefined();
    expect(turn.replyText.length).toBeGreaterThan(0);
  });

  it('invalid tool args → handler is SKIPPED (db untouched), error fed to responder', async () => {
    // list_leads requires entityType; omit it → argsSchema fails → tool.run never called.
    const turn = await runCopilotTurn(
      { db: throwingDb, organizationId: 'org', history: [], userMessage: 'list my leads' },
      fakeReg(JSON.stringify({ action: 'tool', tool: 'list_leads', args: '{}' })),
    );
    expect(turn.toolCall?.name).toBe('list_leads');
    expect((turn.toolCall?.result as { error?: string })?.error).toBe('invalid args');
    expect(turn.replyText).toBe('RESPONDER_REPLY'); // responder still answered
  });
});

describe('suggestActions (deterministic, account-state-driven)', () => {
  const base: AccountCounts = {
    kbDocuments: 0,
    coachingPoints: 0,
    proofItems: 0,
    leads: 0,
    lists: 0,
    tasks: 0,
  };

  it('empty KB → set up knowledge base', () => {
    expect(suggestActions(base)[0]?.label).toBe('Set up your knowledge base');
  });

  it('KB but no leads → find leads', () => {
    expect(suggestActions({ ...base, coachingPoints: 2 })[0]?.label).toBe('Find your first leads');
  });

  it('leads but no lists → organize into a list', () => {
    expect(suggestActions({ ...base, coachingPoints: 2, leads: 5 })[0]?.label).toBe(
      'Organize leads into a list',
    );
  });

  it('leads + lists but no tasks → generate a draft', () => {
    expect(suggestActions({ ...base, coachingPoints: 2, leads: 5, lists: 1 })[0]?.label).toBe(
      'Generate a grounded draft',
    );
  });

  it('steady state → suggest ICP personas', () => {
    expect(
      suggestActions({
        kbDocuments: 1,
        coachingPoints: 2,
        proofItems: 1,
        leads: 5,
        lists: 1,
        tasks: 3,
      })[0]?.label,
    ).toBe('Suggest ICP personas from my KB');
  });
});
