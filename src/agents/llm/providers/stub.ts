import type { LLMProvider } from '../provider.js';
import type { LLMResponse, ProviderRequest } from '../types.js';

// Placeholder provider. Real adapters (Anthropic now; DeepSeek/Gemini in Slice 3b)
// implement the same interface and are registered in complete.ts.
export const stubProvider: LLMProvider = {
  id: 'stub',
  async generate(_req: ProviderRequest): Promise<LLMResponse> {
    throw new Error('LLM provider not wired');
  },
};
