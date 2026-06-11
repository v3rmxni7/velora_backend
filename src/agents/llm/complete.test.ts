import { describe, expect, it } from 'vitest';
import { complete } from './complete.js';
import type { LLMProvider } from './provider.js';

const ok = (id: string): LLMProvider => ({
  id,
  async generate(req) {
    return { text: '{}', model: req.model, inputTokens: 1, outputTokens: 1 };
  },
});
const throwing = (id: string): LLMProvider => ({
  id,
  async generate() {
    throw new Error('rate_limit');
  },
});
const msg = { messages: [{ role: 'user' as const, content: 'x' }] };

describe('complete() provider resolution + failover', () => {
  it('serves the researcher from the cheap provider (deepseek) when healthy', async () => {
    // researcher routes: gemini-flash-lite (google, unregistered) → deepseek-v3.2 → haiku
    const res = await complete('researcher', msg, {
      deepseek: ok('deepseek'),
      anthropic: ok('anthropic'),
    });
    expect(res.model).toBe('deepseek-v3.2');
  });

  it('falls back to Haiku when the cheap provider THROWS (reliability headline)', async () => {
    const res = await complete('researcher', msg, {
      deepseek: throwing('deepseek'),
      anthropic: ok('anthropic'),
    });
    expect(res.model).toBe('claude-haiku-4-5');
  });

  it('Writer fails over Sonnet → GPT when the strong provider errors', async () => {
    // writer routes: claude-sonnet-4-6 (anthropic) → gpt-5.4 (openai) → claude-haiku-4-5
    const res = await complete('writer', msg, {
      anthropic: throwing('anthropic'),
      openai: ok('openai'),
    });
    expect(res.model).toBe('gpt-5.4');
  });

  it('throws when no provider is registered', async () => {
    await expect(complete('researcher', msg, {})).rejects.toThrow();
  });
});
