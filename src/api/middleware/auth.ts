import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createUserClient, getSupabaseAnon } from '../../db/user-client.js';
import { AppError } from '../../lib/errors.js';

export type OrgRole = 'owner' | 'admin' | 'member';

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated Supabase user (set by `authenticate`). */
    user?: { id: string; email?: string };
    /** The caller's organization id, resolved via the user-scoped client. */
    organizationId?: string;
    /** The caller's role within the org (4.8 — the first role gate). */
    userRole?: OrgRole;
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
    .select('organization_id, role')
    .eq('id', data.user.id)
    .single();
  if (profileError || !profile) {
    return reply.code(403).send({ error: 'forbidden', message: 'No organization for this user' });
  }

  request.user = { id: data.user.id, email: data.user.email ?? undefined };
  request.organizationId = profile.organization_id as string;
  request.userRole = profile.role as OrgRole;
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
  role: OrgRole;
} {
  if (!request.db || !request.organizationId || !request.user || !request.userRole) {
    throw new AppError('Not authenticated', { code: 'unauthorized', statusCode: 401 });
  }
  return {
    db: request.db,
    organizationId: request.organizationId,
    userId: request.user.id,
    role: request.userRole,
  };
}

/**
 * Assert the caller's role is one of `allowed`, else 403. The FIRST role gate in the app (4.8) — RLS
 * scopes by org; THIS gates by role. Must be called inside a handler AFTER `authenticate`.
 */
export function requireRole(request: FastifyRequest, allowed: OrgRole[]): void {
  if (!request.userRole || !allowed.includes(request.userRole)) {
    throw new AppError('Insufficient role', { code: 'forbidden', statusCode: 403 });
  }
}

/**
 * Validate the Supabase JWT but do NOT require an org (4.13 — signup/provisioning). A brand-new
 * signed-up user is authenticated but has no public.users row yet; `authenticate` would 403 them.
 * This gate attaches only the user identity, so the provisioning routes can create their org row.
 * Every other route keeps the org-requiring `authenticate`.
 */
export async function authenticateUser(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (!token) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token' });
  }
  const anon = getSupabaseAnon();
  if (!anon) {
    return reply.code(503).send({ error: 'unavailable', message: 'Supabase is not configured' });
  }
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data.user) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Invalid or expired token' });
  }
  request.user = { id: data.user.id, email: data.user.email ?? undefined };
}

/** Assert `authenticateUser` ran; returns the JWT identity (no org). Throws AppError(401) otherwise. */
export function requireUser(request: FastifyRequest): {
  userId: string;
  email: string | undefined;
} {
  if (!request.user) {
    throw new AppError('Not authenticated', { code: 'unauthorized', statusCode: 401 });
  }
  return { userId: request.user.id, email: request.user.email };
}
