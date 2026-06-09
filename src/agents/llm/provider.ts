import type { LLMRequest, LLMResponse } from './types.js';

export interface LLMProvider {
  generate(req: LLMRequest): Promise<LLMResponse>;
}
