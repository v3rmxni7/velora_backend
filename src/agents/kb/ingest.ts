import type { SupabaseClient } from '@supabase/supabase-js';
import { createOpenAIEmbeddings } from '../../integrations/embeddings/openai.js';
import type { EmbeddingsProvider } from '../../integrations/embeddings/types.js';
import { createFirecrawlScraper } from '../../integrations/scraper/firecrawl.js';
import type { Scraper } from '../../integrations/scraper/types.js';
import { toVectorLiteral } from '../../lib/pgvector.js';
import { chunkText } from './chunk.js';

export interface IngestOptions {
  /** Service-role client — KB writes bypass RLS and are scoped by organizationId. */
  db: SupabaseClient;
  organizationId: string;
  sourceUrl: string;
  scraper?: Scraper;
  embedder?: EmbeddingsProvider;
}

export interface IngestResult {
  kbDocumentId: string;
  chunks: number;
}

/**
 * Scrape → chunk → embed → store. Updates kb_documents.status through the
 * pipeline; replaces existing chunks for the document so re-ingest is safe.
 * Shared by the Inngest job and by direct (test/verification) invocation.
 */
export async function ingestDocument(opts: IngestOptions): Promise<IngestResult> {
  const { db, organizationId, sourceUrl } = opts;
  const scraper = opts.scraper ?? createFirecrawlScraper();
  const embedder = opts.embedder ?? createOpenAIEmbeddings();

  const { data: doc, error: docErr } = await db
    .from('kb_documents')
    .insert({
      organization_id: organizationId,
      kind: 'website',
      source_url: sourceUrl,
      status: 'scraping',
    })
    .select('id')
    .single();
  if (docErr || !doc) throw docErr ?? new Error('failed to create kb_document');
  const kbDocumentId = doc.id as string;

  try {
    const page = await scraper.scrape(sourceUrl);
    await db
      .from('kb_documents')
      .update({ title: page.title ?? null, raw_text: page.markdown, status: 'chunking' })
      .eq('id', kbDocumentId);

    const chunks = chunkText(page.markdown);
    if (chunks.length === 0) {
      await db.from('kb_documents').update({ status: 'ready' }).eq('id', kbDocumentId);
      return { kbDocumentId, chunks: 0 };
    }

    await db.from('kb_documents').update({ status: 'embedding' }).eq('id', kbDocumentId);
    const vectors = await embedder.embed(chunks.map((c) => c.content));

    // Replace any prior chunks for this document, then insert the fresh set.
    await db.from('kb_chunks').delete().eq('kb_document_id', kbDocumentId);
    const rows = chunks.map((c, i) => {
      const vec = vectors[i];
      if (!vec) throw new Error(`missing embedding for chunk ${i}`);
      return {
        organization_id: organizationId,
        kb_document_id: kbDocumentId,
        chunk_index: c.index,
        content: c.content,
        embedding: toVectorLiteral(vec),
        token_count: c.tokenCountEstimate,
        content_hash: c.contentHash,
        embedding_model: embedder.model,
      };
    });
    const { error: insErr } = await db.from('kb_chunks').insert(rows);
    if (insErr) throw insErr;

    await db.from('kb_documents').update({ status: 'ready' }).eq('id', kbDocumentId);
    return { kbDocumentId, chunks: rows.length };
  } catch (err) {
    await db
      .from('kb_documents')
      .update({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
      .eq('id', kbDocumentId);
    throw err;
  }
}
