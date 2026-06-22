import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { LLMProvider } from './provider.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createDeepSeekProvider } from './providers/deepseek.js';
import { selectModel } from './router.js';
import type { LLMMessage, LLMResponse, TaskName } from './types.js';

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'deepseek';
export type ProviderRegistry = Partial<Record<ProviderId, LLMProvider>>;

/** Map a model id to the provider that serves it (prefix-based). */
function providerForModel(model: string): ProviderId {
  if (model.startsWith('gpt')) return 'openai';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('deepseek')) return 'deepseek';
  return 'anthropic'; // claude-* and default
}

// Lazy registry of CONFIGURED providers. Registering an adapter here is all it takes to
// activate the models routed to it in TASK_MODEL_MAP — no router-map change needed.
let registry: ProviderRegistry | null = null;
function getRegistry(): ProviderRegistry {
  if (registry) return registry;
  const reg: ProviderRegistry = {};
  if (env.ANTHROPIC_API_KEY) reg.anthropic = createAnthropicProvider();
  if (env.DEEPSEEK_API_KEY) reg.deepseek = createDeepSeekProvider();
  // openai/google adapters register here when their keys are present.
  registry = reg;
  return reg;
}

/** Clear the memoized registry — test seam (rebuild after changing env/registry). */
export function resetRegistry(): void {
  registry = null;
}

const DEFAULT_FALLBACK_MODEL = 'claude-haiku-4-5';

export interface CompleteOptions {
  system?: string;
  messages: LLMMessage[];
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

/**
 * Task-routed LLM call. Resolves task → model (TASK_MODEL_MAP) → a configured provider,
 * walking [model, failover, Haiku]. A candidate is skipped if its provider isn't registered
 * AND if its generate() throws at runtime (rate-limit/timeout/5xx) — so a cheap-provider
 * outage degrades cleanly to the next candidate (ultimately Haiku).
 */
export async function complete(
  task: TaskName,
  opts: CompleteOptions,
  reg: ProviderRegistry = getRegistry(),
): Promise<LLMResponse> {
  const route = selectModel(task);
  const maxOutputTokens = opts.maxOutputTokens ?? route.maxOutputTokens;
  const candidates = [route.model, route.failover, DEFAULT_FALLBACK_MODEL].filter(
    (m): m is string => Boolean(m),
  );
  let lastErr: unknown;
  for (const model of candidates) {
    const provider = reg[providerForModel(model)];
    if (!provider) continue;
    try {
      return await provider.generate({
        model,
        system: opts.system,
        messages: opts.messages,
        jsonSchema: opts.jsonSchema,
        maxOutputTokens,
      });
    } catch (err) {
      lastErr = err; // fall through to the next candidate (failover)
    }
  }
  if (lastErr) {
    // Every candidate failed (provider 4xx/5xx, rate-limit, exhausted credits, timeout). Log the raw
    // cause server-side for diagnosis, but surface a graceful 503 to the client instead of letting the
    // raw provider error fall through to the generic 500 handler (audit F-RT2). The honest detail (e.g.
    // "credit balance too low") stays in the logs and never reaches the API response.
    console.error(`[llm] all candidates failed for task "${task}":`, lastErr);
    throw new AppError('The AI service is temporarily unavailable. Please try again shortly.', {
      code: 'ai_unavailable',
      statusCode: 503,
    });
  }
  throw new AppError('No LLM provider configured', { code: 'llm_unconfigured', statusCode: 503 });
}
