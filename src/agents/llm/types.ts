// Tasks mirror the SPEC's cost-routing table (Part 6).
export type TaskName =
  | 'onboarding'
  | 'researcher'
  | 'positioning'
  | 'writer'
  | 'reply_classifier'
  | 'reply_drafter'
  | 'copilot'
  | 'embeddings';

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
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  task: TaskName;
  messages: LLMMessage[];
  maxOutputTokens?: number;
}

export interface LLMResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
