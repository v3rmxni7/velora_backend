import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createOpenAIEmbeddings } from '../../integrations/embeddings/openai.js';
import { events, inngest } from '../../workers/inngest/client.js';
import { authenticate, requireAuth } from '../middleware/auth.js';

const IngestBody = z.object({ sourceUrl: z.url() });
const SearchQuery = z.object({
  q: z.string().min(1),
  k: z.coerce.number().int().positive().max(50).optional(),
});

export const kbRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // Authorize, then enqueue the idempotent ingest job. The route never writes
  // KB rows itself (kb_documents/kb_chunks are service-role-only).
  app.post('/kb/ingest', async (request, reply) => {
    const { organizationId } = requireAuth(request);
    const { sourceUrl } = IngestBody.parse(request.body);
    const dedupeKey = `kb-ingest:${organizationId}:${sourceUrl}`;
    await inngest.send({
      name: events.kbIngest.name,
      data: { organizationId, sourceUrl, dedupeKey },
    });
    return reply.code(202).send({ status: 'queued', dedupeKey });
  });

  app.get('/kb/documents', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('kb_documents')
      .select('id, kind, source_url, title, status, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  app.get('/kb/search', async (request) => {
    const { db, organizationId } = requireAuth(request);
    const { q, k } = SearchQuery.parse(request.query);
    const embedder = createOpenAIEmbeddings();
    const [vec] = await embedder.embed([q]);
    if (!vec) return { data: [] };
    const { data, error } = await db.rpc('match_kb_chunks', {
      p_org_id: organizationId,
      p_query_embedding: vec,
      p_match_count: k ?? 8,
    });
    if (error) throw error;
    return { data };
  });
};
