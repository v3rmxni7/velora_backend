import OpenAI from 'openai';
import { selectModel } from '../../agents/llm/router.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { EmbeddingsProvider } from './types.js';

// 1536 is the native dimension for text-embedding-3-small and is LOCKED to the
// kb_chunks.embedding vector(1536) column (changing it requires re-embedding).
const DIMENSIONS = 1536;

export function createOpenAIEmbeddings(): EmbeddingsProvider {
  if (!env.OPENAI_API_KEY) {
    throw new AppError('OPENAI_API_KEY is not configured', {
      code: 'embeddings_unconfigured',
      statusCode: 503,
    });
  }
  const model = selectModel('embeddings').model;
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return {
    model,
    dimensions: DIMENSIONS,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await client.embeddings.create({ model, input: texts, dimensions: DIMENSIONS });
      return res.data.map((d) => d.embedding);
    },
  };
}
