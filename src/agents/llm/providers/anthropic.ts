import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../../config/env.js';
import { AppError } from '../../../lib/errors.js';
import type { LLMProvider } from '../provider.js';
import type { LLMResponse, ProviderRequest } from '../types.js';

export function createAnthropicProvider(): LLMProvider {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError('ANTHROPIC_API_KEY is not configured', {
      code: 'llm_unconfigured',
      statusCode: 503,
    });
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return {
    id: 'anthropic',
    async generate(req: ProviderRequest): Promise<LLMResponse> {
      const res = await client.messages.create({
        model: req.model,
        max_tokens: req.maxOutputTokens ?? 1024,
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        // Structured outputs: constrain the model to the caller's JSON Schema.
        ...(req.jsonSchema
          ? { output_config: { format: { type: 'json_schema' as const, schema: req.jsonSchema } } }
          : {}),
      });
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return {
        text,
        model: req.model,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      };
    },
  };
}
