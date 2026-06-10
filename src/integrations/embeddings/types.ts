export interface EmbeddingsProvider {
  /** Model id (single source of truth is the LLM router map). */
  readonly model: string;
  /** Vector dimensions — must match the kb_chunks.embedding column. */
  readonly dimensions: number;
  /** Embed a batch of texts; returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}
