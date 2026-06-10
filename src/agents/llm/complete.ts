import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { LLMProvider } from './provider.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { selectModel } from './router.js';
import type { LLMMessage, LLMResponse, TaskName } from './types.js';

type ProviderId = 'anthropic' | 'openai' | 'google' | 'deepseek';

/** Map a model id to the provider that serves it (prefix-based). */
function providerForModel(model: string): ProviderId {
  if (model.startsWith('gpt')) return 'openai';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('deepseek')) return 'deepseek';
  return 'anthropic'; // claude-* and default
}

// Lazy registry of CONFIGURED providers. Slice 2 registers Anthropic only;
// Slice 3b adds openai/google/deepseek adapters here — no router-map change needed.
let registry: Partial<Record<ProviderId, LLMProvider>> | null = null;
function getRegistry(): Partial<Record<ProviderId, LLMProvider>> {
  if (registry) return registry;
  const reg: Partial<Record<ProviderId, LLMProvider>> = {};
  if (env.ANTHROPIC_API_KEY) reg.anthropic = createAnthropicProvider();
  registry = reg;
  return reg;
}

const DEFAULT_FALLBACK_MODEL = 'claude-haiku-4-5';

export interface CompleteOptions {
  system?: string;
  messages: LLMMessage[];
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

/**
 * Single entry point for task-routed LLM calls. Resolves the task → model
 * (TASK_MODEL_MAP) → a configured provider, walking model then failover, then a
 * safe default (Haiku). This is the seam that lets the cheap tier "light up" in
 * Slice 3b without touching call sites.
 */
export async function complete(task: TaskName, opts: CompleteOptions): Promise<LLMResponse> {
  const route = selectModel(task);
  const reg = getRegistry();
  const maxOutputTokens = opts.maxOutputTokens ?? route.maxOutputTokens;

  const candidates = [route.model, route.failover, DEFAULT_FALLBACK_MODEL].filter(
    (m): m is string => Boolean(m),
  );
  for (const model of candidates) {
    const provider = reg[providerForModel(model)];
    if (provider) {
      return provider.generate({
        model,
        system: opts.system,
        messages: opts.messages,
        jsonSchema: opts.jsonSchema,
        maxOutputTokens,
      });
    }
  }
  throw new AppError('No LLM provider configured', { code: 'llm_unconfigured', statusCode: 503 });
}
