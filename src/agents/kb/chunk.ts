import { createHash } from 'node:crypto';

export interface Chunk {
  index: number;
  content: string;
  contentHash: string;
  /** Rough token estimate (~chars/4) — exact counts aren't needed in Phase 1. */
  tokenCountEstimate: number;
}

// ~800–1,000 tokens per chunk with ~15% overlap (chars ≈ tokens × 4).
const TARGET_CHARS = 3500;
const OVERLAP_CHARS = 500;

/** Split text into overlapping chunks with a content hash per chunk. */
export function chunkText(text: string): Chunk[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < clean.length) {
    const end = Math.min(start + TARGET_CHARS, clean.length);
    const slice = clean.slice(start, end).trim();
    if (slice) {
      chunks.push({
        index,
        content: slice,
        contentHash: createHash('sha256').update(slice).digest('hex'),
        tokenCountEstimate: Math.ceil(slice.length / 4),
      });
      index += 1;
    }
    if (end >= clean.length) break;
    start = end - OVERLAP_CHARS;
  }
  return chunks;
}
