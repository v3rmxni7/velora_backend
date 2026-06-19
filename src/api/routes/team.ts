import { createHash, randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getSupabaseAdmin } from '../../db/client.js';
import { recordAuditSafe } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { authenticate, requireAuth, requireRole } from '../middleware/auth.js';

// Phase 4 Slice 4.8 — the Team surface. List members + manage roles/removal (role-gated, the FIRST
// role gate in the app) + an HONEST-SHELL invite (a pending invitation + a hashed token; NO email is
// sent — no SMTP exists — and the accept route + signup UI are a DEFERRED onboarding slice). Reads use
// the user-scoped client (the new "org members read users/invitations" RLS policies); mutating writes
// go through the service-role admin client scoped to the caller's JWT org (users/team_invitations have
// no authenticated write policy). The last-owner lockout is prevented by a DB trigger (caught → 409).
const IdParam = z.object({ id: z.uuid() });
const Invite = z.object({
  email: z.email().max(255),
  role: z.enum(['admin', 'member']).default('member'),
});
const RoleBody = z.object({ role: z.enum(['owner', 'admin', 'member']) });

function admin() {
  const db = getSupabaseAdmin();
  if (!db)
    throw new AppError('Service-role client unavailable', {
      code: 'admin_unavailable',
      statusCode: 503,
    });
  return db;
}

const isLastOwnerError = (err: { message?: string } | null): boolean =>
  !!err?.message?.includes('org_must_retain_owner');

export const teamRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  // The caller's identity + role + org (drives the FE's role-gated controls) + the honest invite-email
  // capability flag (false: no SMTP configured → invites produce a copyable link, never an email).
  app.get('/team/me', async (request) => {
    const { db, userId, role, organizationId } = requireAuth(request);
    const [org, me] = await Promise.all([
      db.from('organizations').select('id, name').eq('id', organizationId).single(),
      db.from('users').select('email').eq('id', userId).single(),
    ]);
    if (org.error) throw org.error;
    if (me.error) throw me.error;
    return {
      data: {
        user: { id: userId, email: me.data.email, role },
        organization: { id: org.data.id, name: org.data.name },
        inviteEmailConfigured: false, // no SMTP configured; flip when invite email delivery lands
      },
    };
  });

  // Co-members (RLS-scoped via the new "org members read users" policy). Any member may view.
  app.get('/team/members', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('users')
      .select('id, email, role, created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return { data: { members: data ?? [] } };
  });

  // Pending invitations (RLS-scoped). Never returns the token/hash.
  app.get('/team/invitations', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('team_invitations')
      .select('id, email, role, status, expires_at, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data: { invitations: data ?? [] } };
  });

  // Invite (owner/admin). HONEST-SHELL: creates/refreshes a pending invitation + returns a one-time
  // raw token for the FE to compose a copyable accept link. NEVER claims an email was sent.
  app.post('/team/invitations', async (request, reply) => {
    requireRole(request, ['owner', 'admin']);
    const { db, organizationId, userId } = requireAuth(request);
    const body = Invite.parse(request.body);
    const email = body.email.trim().toLowerCase();

    // Already a member of this org? (RLS scopes the read to the caller's org.)
    const member = await db.from('users').select('id').ilike('email', email).maybeSingle();
    if (member.error) throw member.error;
    if (member.data) return reply.code(409).send({ error: 'already_member' });

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const a = admin();
    // Refresh an existing pending invite, else insert a fresh one (the partial unique index allows
    // one pending per (org,email); a concurrent insert → 23505 is treated as success).
    const upd = await a
      .from('team_invitations')
      .update({ token_hash: tokenHash, role: body.role, expires_at: expiresAt, invited_by: userId })
      .eq('organization_id', organizationId)
      .eq('email', email)
      .eq('status', 'pending')
      .select('id');
    if (upd.error) throw upd.error;
    if ((upd.data ?? []).length === 0) {
      const ins = await a.from('team_invitations').insert({
        organization_id: organizationId,
        email,
        role: body.role,
        token_hash: tokenHash,
        expires_at: expiresAt,
        invited_by: userId,
      });
      if (ins.error && ins.error.code !== '23505') throw ins.error;
    }
    return { data: { token: rawToken, email, role: body.role, expiresAt } };
  });

  app.post('/team/invitations/:id/revoke', async (request, reply) => {
    requireRole(request, ['owner', 'admin']);
    const { organizationId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const upd = await admin()
      .from('team_invitations')
      .update({ status: 'revoked' })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (upd.error) throw upd.error;
    if (!upd.data) return reply.code(404).send({ error: 'not_found' });
    return { data: { id, status: 'revoked' } };
  });

  // Change a member's role (OWNER only — only an owner touches any role). Rails: cannot change your
  // own role; the last-owner demotion is blocked by the DB trigger (→ 409 last_owner).
  app.patch('/team/members/:id', async (request, reply) => {
    requireRole(request, ['owner']);
    const { organizationId, userId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { role } = RoleBody.parse(request.body);
    if (id === userId) return reply.code(409).send({ error: 'cannot_change_own_role' });
    const a = admin();
    const target = await a
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (target.error) throw target.error;
    if (!target.data) return reply.code(404).send({ error: 'not_found' });
    const upd = await a
      .from('users')
      .update({ role })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('id, email, role')
      .maybeSingle();
    if (upd.error) {
      if (isLastOwnerError(upd.error)) return reply.code(409).send({ error: 'last_owner' });
      throw upd.error;
    }
    await recordAuditSafe(a, {
      organizationId,
      kind: 'team_role_changed',
      userId,
      args: { memberId: id, newRole: role, email: upd.data?.email },
      source: 'user',
    });
    return { data: upd.data };
  });

  // Remove a member (OWNER only) = delete the public.users membership row (NOT the global auth user —
  // reversible, preserves single-org-per-user). Rails: cannot remove yourself; last-owner → 409.
  app.delete('/team/members/:id', async (request, reply) => {
    requireRole(request, ['owner']);
    const { organizationId, userId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    if (id === userId) return reply.code(409).send({ error: 'cannot_remove_self' });
    const a = admin();
    const target = await a
      .from('users')
      .select('id')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (target.error) throw target.error;
    if (!target.data) return reply.code(404).send({ error: 'not_found' });
    const del = await a
      .from('users')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select('id')
      .maybeSingle();
    if (del.error) {
      if (isLastOwnerError(del.error)) return reply.code(409).send({ error: 'last_owner' });
      throw del.error;
    }
    await recordAuditSafe(a, {
      organizationId,
      kind: 'team_member_removed',
      userId,
      args: { memberId: id },
      source: 'user',
    });
    return { data: { id, removed: true } };
  });
};
