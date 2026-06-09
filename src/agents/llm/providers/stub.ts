import type { LLMProvider } from '../provider.js';
import type { LLMRequest, LLMResponse } from '../types.js';

// Placeholder so the router typechecks in Phase 0. Real provider adapters
// (Anthropic / OpenAI / Google, BYOK) arrive in Phase 1.
export const stubProvider: LLMProvider = {
  async generate(_req: LLMRequest): Promise<LLMResponse> {
    throw new Error('LLM provider not wired (Phase 1)');
  },
};
