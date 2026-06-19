import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { getSupabaseAdmin } from '../../db/client.js';
import { authenticateUser, requireUser } from '../middleware/auth.js';

// 4.13 — self-serve signup + accept-invite. Its OWN plugin: it uses authenticateUser (validates the
// Supabase JWT but tolerates a missing public.users row), NOT the org-requiring `authenticate` that
// 403s an orgless user. All writes go through the service-role admin (users/organizations have no
// authenticated write policy), scoped to the JWT's own user id — never a client-supplied id.
const AcceptBody = z.object({ token: z.string().min(16).max(256) });

function orgNameFromEmail(email: string | undefined): string {
  const local = email?.split('@')[0]?.trim();
  return local ? `${local}'s workspace` : 'My workspace';
}

export const authRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticateUser);

  // Provision an authenticated-but-orgless user into a NEW org (owner) + a welcome grant. Idempotent:
  // a user already linked to an org just gets it back (the users PK makes a second provision a no-op).
  app.post('/auth/provision', async (request, reply) => {
    const { userId, email } = requireUser(request);
    const admin = getSupabaseAdmin();
    if (!admin) return reply.code(503).send({ error: 'unavailable' });

    const existing = await admin
      .from('users')
      .select('organization_id, role')
      .eq('id', userId)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      return {
        data: {
          organizationId: existing.data.organization_id,
          role: existing.data.role,
          provisioned: false,
        },
      };
    }

    const org = await admin
      .from('organizations')
      .insert({ name: orgNameFromEmail(email) })
      .select('id')
      .single();
    if (org.error) throw org.error;
    const orgId = org.data.id as string;

    const ins = await admin
      .from('users')
      .insert({ id: userId, organization_id: orgId, email: email ?? null, role: 'owner' });
    if (ins.error) {
      // Race: a concurrent provision already created the membership → drop the empty org we just made
      // (no members, no data) and return the winner's org.
      if (ins.error.code === '23505') {
        await admin.from('organizations').delete().eq('id', orgId);
        const row = await admin
          .from('users')
          .select('organization_id, role')
          .eq('id', userId)
          .single();
        if (row.error) throw row.error;
        return {
          data: {
            organizationId: row.data.organization_id,
            role: row.data.role,
            provisioned: false,
          },
        };
      }
      throw ins.error;
    }

    if (env.SIGNUP_GRANT_CREDITS > 0) {
      const grant = await admin.from('credit_ledger').insert({
        organization_id: orgId,
        delta: env.SIGNUP_GRANT_CREDITS,
        reason: 'signup_grant',
        idempotency_key: `signup:${userId}`,
      });
      if (grant.error && grant.error.code !== '23505') throw grant.error;
    }

    return reply
      .code(201)
      .send({ data: { organizationId: orgId, role: 'owner', provisioned: true } });
  });

  // Accept a team invite → join the inviter's org. Single-org model: the caller must be orgless.
  app.post('/auth/accept-invite', async (request, reply) => {
    const { userId, email } = requireUser(request);
    const { token } = AcceptBody.parse(request.body);
    const admin = getSupabaseAdmin();
    if (!admin) return reply.code(503).send({ error: 'unavailable' });

    const existing = await admin.from('users').select('id').eq('id', userId).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) return reply.code(409).send({ error: 'already_in_org' });

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const invite = await admin
      .from('team_invitations')
      .select('id, organization_id, email, role, status, expires_at')
      .eq('token_hash', tokenHash)
      .eq('status', 'pending')
      .maybeSingle();
    if (invite.error) throw invite.error;
    if (!invite.data) return reply.code(404).send({ error: 'invalid_invite' });

    // Only the invited address may accept — the hash alone isn't enough.
    if (!email || email.toLowerCase() !== String(invite.data.email).toLowerCase()) {
      return reply
        .code(403)
        .send({ error: 'email_mismatch', message: 'This invite was sent to a different address.' });
    }
    if (new Date(invite.data.expires_at as string) < new Date()) {
      await admin.from('team_invitations').update({ status: 'expired' }).eq('id', invite.data.id);
      return reply.code(410).send({ error: 'invite_expired' });
    }

    const ins = await admin.from('users').insert({
      id: userId,
      organization_id: invite.data.organization_id,
      email: email ?? null,
      role: invite.data.role, // 'admin' | 'member' (never owner — the invite CHECK enforces it)
    });
    if (ins.error && ins.error.code !== '23505') throw ins.error;

    await admin
      .from('team_invitations')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('id', invite.data.id);

    return { data: { organizationId: invite.data.organization_id, role: invite.data.role } };
  });
};
