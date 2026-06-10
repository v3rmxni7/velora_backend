import type { LLMResponse, ProviderRequest } from './types.js';

export interface LLMProvider {
  /** Stable id used by the registry/resolver (e.g. 'anthropic'). */
  readonly id: string;
  generate(req: ProviderRequest): Promise<LLMResponse>;
}
