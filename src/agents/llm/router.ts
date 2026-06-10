import type { ModelRoute, TaskName } from './types.js';

// Single source of truth for task → model routing. No model name lives anywhere
// else in the codebase. Cheap models handle ~90% of calls; the strong model is
// reserved for the final outbound email (output capped to ~200 tokens).
// Model ids are placeholders re-verified at integration time (Phase 1).
export const TASK_MODEL_MAP: Record<TaskName, ModelRoute> = {
  onboarding: { tier: 'mid', model: 'claude-haiku-4-5', cacheKb: true },
  researcher: {
    tier: 'cheap',
    model: 'gemini-flash-lite',
    failover: 'deepseek-v3.2',
    cacheKb: true,
  },
  positioning: { tier: 'mid', model: 'claude-haiku-4-5' },
  writer: {
    tier: 'strong',
    model: 'claude-sonnet-4-6',
    failover: 'gpt-5.4',
    maxOutputTokens: 200,
    cacheKb: true,
  },
  reply_classifier: { tier: 'cheap', model: 'gemini-flash-lite', failover: 'deepseek-v3.2' },
  reply_drafter: { tier: 'mid', model: 'claude-haiku-4-5' },
  copilot: { tier: 'mid', model: 'claude-haiku-4-5', cacheKb: true },
  embeddings: { tier: 'embedding', model: 'text-embedding-3-small' },
  // NL → structured filters: short extraction. Anthropic Haiku in Slice 2;
  // reassigned to the cheap tier (Flash-Lite/DeepSeek) in Slice 3b.
  nl_to_filters: { tier: 'mid', model: 'claude-haiku-4-5', maxOutputTokens: 400 },
  // ICP suggestions: reads the per-customer KB (cache it), short reasoning.
  icp_suggestions: { tier: 'mid', model: 'claude-haiku-4-5', maxOutputTokens: 600, cacheKb: true },
};

export function selectModel(task: TaskName): ModelRoute {
  return TASK_MODEL_MAP[task];
}
