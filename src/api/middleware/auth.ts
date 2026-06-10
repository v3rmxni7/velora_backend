import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createUserClient, getSupabaseAnon } from '../../db/user-client.js';
import { AppError } from '../../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated Supabase user (set by `authenticate`). */
    user?: { id: string; email?: string };
    /** The caller's organization id, resolved via the user-scoped client. */
    organizationId?: string;
    /** User-scoped (RLS-enforcing) Supabase client for this request. */
    db?: SupabaseClient;
  }
}

/**
 * Fastify preHandler that authenticates the request and attaches a user-scoped,
 * RLS-enforcing Supabase client. Every user-facing route registers this so
 * tenant isolation is enforced by Postgres, never by application code.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token' });
  }

  const anon = getSupabaseAnon();
  const db = createUserClient(token);
  if (!anon || !db) {
    return reply.code(503).send({ error: 'unavailable', message: 'Supabase is not configured' });
  }

  const { data, error } = await anon.auth.getUser(token);
  if (error || !data.user) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Invalid or expired token' });
  }

  // Resolve org through the user-scoped client — exercises the "users read self"
  // RLS policy, so a working result is also proof RLS is in force.
  const { data: profile, error: profileError } = await db
    .from('users')
    .select('organization_id')
    .eq('id', data.user.id)
    .single();
  if (profileError || !profile) {
    return reply.code(403).send({ error: 'forbidden', message: 'No organization for this user' });
  }

  request.user = { id: data.user.id, email: data.user.email ?? undefined };
  request.organizationId = profile.organization_id as string;
  request.db = db;
}

/**
 * Assert the request passed `authenticate` and return its non-null context.
 * Throws AppError(401) otherwise — keeps route handlers free of `!` assertions.
 */
export function requireAuth(request: FastifyRequest): {
  db: SupabaseClient;
  organizationId: string;
  userId: string;
} {
  if (!request.db || !request.organizationId || !request.user) {
    throw new AppError('Not authenticated', { code: 'unauthorized', statusCode: 401 });
  }
  return { db: request.db, organizationId: request.organizationId, userId: request.user.id };
}
