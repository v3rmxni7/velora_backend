import OpenAI from 'openai';
import { env } from '../../../config/env.js';
import { AppError } from '../../../lib/errors.js';
import type { LLMProvider } from '../provider.js';
import type { LLMResponse, ProviderRequest } from '../types.js';

// Our router uses the label 'deepseek-v3.2'; 'deepseek-chat' is DeepSeek's non-reasoning
// V3-line chat model (compact output) — the right fit for cheap extraction. ('deepseek-v4-flash'
// is a reasoning/V4 model that runs away verbose on small structured tasks.)
const DEEPSEEK_MODEL = 'deepseek-chat';

// DeepSeek is OpenAI-compatible — reuse the OpenAI SDK pointed at its base URL (no new dep).
export function createDeepSeekProvider(): LLMProvider {
  if (!env.DEEPSEEK_API_KEY) {
    throw new AppError('DEEPSEEK_API_KEY is not configured', {
      code: 'llm_unconfigured',
      statusCode: 503,
    });
  }
  const client = new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_BASE_URL });
  return {
    id: 'deepseek',
    async generate(req: ProviderRequest): Promise<LLMResponse> {
      const messages = [
        ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ];
      const res = await client.chat.completions.create({
        model: DEEPSEEK_MODEL,
        max_tokens: req.maxOutputTokens ?? 1024,
        messages,
        // OpenAI-compatible JSON mode: valid JSON, not schema-strict. The downstream Zod gate
        // is authoritative, so safety is identical to Anthropic regardless of provider. Callers'
        // prompts already instruct "Return JSON".
        ...(req.jsonSchema ? { response_format: { type: 'json_object' as const } } : {}),
      });
      return {
        text: res.choices[0]?.message?.content ?? '',
        model: DEEPSEEK_MODEL,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
    },
  };
}
