// Tasks mirror the SPEC's cost-routing table (Part 6), plus Slice-2 lead tasks.
export type TaskName =
  | 'onboarding'
  | 'researcher'
  | 'positioning'
  | 'writer'
  | 'reply_classifier'
  | 'reply_drafter'
  | 'copilot'
  | 'embeddings'
  | 'nl_to_filters'
  | 'icp_suggestions';

export type ModelTier = 'cheap' | 'mid' | 'strong' | 'embedding';

export interface ModelRoute {
  tier: ModelTier;
  model: string;
  failover?: string;
  maxOutputTokens?: number;
  /** Reuse the per-customer KB via prompt caching (~10% input cost). */
  cacheKb?: boolean;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A fully-resolved request handed to a provider adapter (model already chosen). */
export interface ProviderRequest {
  model: string;
  system?: string;
  messages: LLMMessage[];
  maxOutputTokens?: number;
  /** When set, the provider constrains output to this JSON Schema (structured outputs). */
  jsonSchema?: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
