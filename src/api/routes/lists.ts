import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuth } from '../middleware/auth.js';

const ENTITY = z.enum(['person', 'company', 'local_business']);
const TABLE = {
  person: 'people',
  company: 'companies',
  local_business: 'local_businesses',
} as const;

const CreateList = z.object({
  name: z.string().min(1).max(200),
  entityType: ENTITY,
  description: z.string().max(2000).optional(),
});
const UpdateList = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
});
const IdParam = z.object({ id: z.uuid() });
const MemberParam = z.object({ id: z.uuid(), memberId: z.uuid() });
const MembersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// Incoming provider matches to persist (bounded; unknown keys stripped). Enum fields
// match the DB CHECK constraints so bad values fail as 400, not a DB error.
const PersonInput = z.object({
  externalId: z.string().min(1).max(200),
  provider: z.string().max(50).default('seed'),
  firstName: z.string().max(200).optional(),
  lastName: z.string().max(200).optional(),
  fullName: z.string().max(400).optional(),
  email: z.string().max(320).optional(),
  title: z.string().max(300).optional(),
  seniority: z.enum(['c_level', 'vp', 'director', 'manager', 'senior', 'mid', 'entry']).optional(),
  department: z
    .enum([
      'engineering',
      'sales',
      'marketing',
      'product',
      'finance',
      'operations',
      'hr',
      'legal',
      'support',
      'other',
    ])
    .optional(),
  companyName: z.string().max(300).optional(),
  location: z.string().max(200).optional(),
  country: z.string().max(100).optional(),
  linkedinUrl: z.string().max(500).optional(),
});
const SIZES = z.enum(['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+']);
const CompanyInput = z.object({
  externalId: z.string().min(1).max(200),
  provider: z.string().max(50).default('seed'),
  name: z.string().min(1).max(300),
  domain: z.string().max(255).optional(),
  industry: z
    .enum([
      'saas',
      'fintech',
      'healthcare',
      'ecommerce',
      'manufacturing',
      'agency',
      'edtech',
      'biotech',
      'logistics',
      'real_estate',
    ])
    .optional(),
  sizeBand: SIZES.optional(),
  employeeCount: z.number().int().nonnegative().optional(),
  location: z.string().max(200).optional(),
  country: z.string().max(100).optional(),
  linkedinUrl: z.string().max(500).optional(),
});
const LocalInput = z.object({
  externalId: z.string().min(1).max(200),
  provider: z.string().max(50).default('seed'),
  name: z.string().min(1).max(300),
  category: z
    .enum([
      'restaurant',
      'dentist',
      'gym',
      'salon',
      'law_firm',
      'cafe',
      'auto_repair',
      'real_estate_agency',
    ])
    .optional(),
  phone: z.string().max(50).optional(),
  address: z.string().max(300).optional(),
  city: z.string().max(120).optional(),
  country: z.string().max(100).optional(),
  website: z.string().max(500).optional(),
  googleMapsUrl: z.string().max(500).optional(),
  rating: z.number().min(0).max(5).optional(),
});

const AddMembers = z.object({ matches: z.array(z.unknown()).min(1).max(200) });

type EntityType = z.infer<typeof ENTITY>;
type Row = Record<string, unknown>;

// Dedupe rows by the (provider, external_id) upsert conflict key (keep last) so a single request
// batch containing the same lead twice can't trip Postgres 21000 "ON CONFLICT DO UPDATE command
// cannot affect row a second time" → a 500 (audit N7).
export function dedupeRowsByConflict(rows: Row[]): Row[] {
  const seen = new Map<string, Row>();
  for (const r of rows) seen.set(`${String(r.provider)}:${String(r.external_id)}`, r);
  return [...seen.values()];
}

function toRow(entityType: EntityType, organizationId: string, match: unknown): Row {
  if (entityType === 'person') {
    const m = PersonInput.parse(match);
    return {
      organization_id: organizationId,
      provider: m.provider,
      external_id: m.externalId,
      first_name: m.firstName,
      last_name: m.lastName,
      full_name: m.fullName,
      email: m.email,
      title: m.title,
      seniority: m.seniority,
      department: m.department,
      company_name: m.companyName,
      location: m.location,
      country: m.country,
      linkedin_url: m.linkedinUrl,
      source: 'find_leads',
    };
  }
  if (entityType === 'company') {
    const m = CompanyInput.parse(match);
    return {
      organization_id: organizationId,
      provider: m.provider,
      external_id: m.externalId,
      name: m.name,
      domain: m.domain,
      industry: m.industry,
      size_band: m.sizeBand,
      employee_count: m.employeeCount,
      location: m.location,
      country: m.country,
      linkedin_url: m.linkedinUrl,
      source: 'find_leads',
    };
  }
  const m = LocalInput.parse(match);
  return {
    organization_id: organizationId,
    provider: m.provider,
    external_id: m.externalId,
    name: m.name,
    category: m.category,
    phone: m.phone,
    address: m.address,
    city: m.city,
    country: m.country,
    website: m.website,
    google_maps_url: m.googleMapsUrl,
    rating: m.rating,
    source: 'find_leads',
  };
}

export const listsRoute: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authenticate);

  app.get('/lists', async (request) => {
    const { db } = requireAuth(request);
    const { data, error } = await db
      .from('lists')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return { data };
  });

  app.post('/lists', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const body = CreateList.parse(request.body);
    const { data, error } = await db
      .from('lists')
      .insert({
        organization_id: organizationId,
        name: body.name,
        entity_type: body.entityType,
        description: body.description,
      })
      .select('*')
      .single();
    if (error) throw error;
    return reply.code(201).send({ data });
  });

  app.patch('/lists/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const body = UpdateList.parse(request.body);
    const { data, error } = await db
      .from('lists')
      .update(body)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return { data };
  });

  app.delete('/lists/:id', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { error } = await db.from('lists').delete().eq('id', id);
    if (error) throw error;
    return reply.code(204).send();
  });

  // Hydrated membership: each member row joined to its lead record (name/title/company etc.) so
  // the UI can render named, actionable members. list_members is polymorphic (entity_type+entity_id,
  // no FK) so we hydrate with ONE .in() query per entity-type present — constant round-trips, never
  // N+1. Org-scoped at every step (the list, the members, the leads are all RLS-confined).
  app.get('/lists/:id/members', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { limit, offset } = MembersQuery.parse(request.query);

    // 404 if the list isn't visible to this org (RLS) — clean, no existence leak.
    const list = await db.from('lists').select('id').eq('id', id).maybeSingle();
    if (list.error) throw list.error;
    if (!list.data) return reply.code(404).send({ error: 'not_found' });

    // One query: the page of membership rows + the exact total (for an accurate count when paged).
    const mem = await db
      .from('list_members')
      .select('*', { count: 'exact' })
      .eq('list_id', id)
      .order('added_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (mem.error) throw mem.error;
    const rows = mem.data ?? [];

    // Group the page's ids by entity_type, hydrate each type in a single .in() query.
    const idsByType = new Map<EntityType, string[]>();
    for (const r of rows) {
      const t = r.entity_type as EntityType;
      idsByType.set(t, [...(idsByType.get(t) ?? []), r.entity_id as string]);
    }
    const leadById = new Map<string, Row>();
    for (const [type, ids] of idsByType) {
      const res = await db.from(TABLE[type]).select('*').in('id', ids);
      if (res.error) throw res.error;
      for (const lead of res.data ?? []) leadById.set(lead.id as string, lead as Row);
    }

    // Orphaned membership (lead deleted — entity_id has no FK/cascade) → lead: null, not an error.
    const members = rows.map((r) => ({ ...r, lead: leadById.get(r.entity_id as string) ?? null }));
    return { data: { count: mem.count ?? members.length, limit, offset, members } };
  });

  // Add-to-list: persist selected provider matches into the org-scoped entity table,
  // then attach them to the list. The list's entity_type drives validation + target table.
  app.post('/lists/:id/members', async (request, reply) => {
    const { db, organizationId } = requireAuth(request);
    const { id } = IdParam.parse(request.params);
    const { matches } = AddMembers.parse(request.body);

    const list = await db.from('lists').select('id, entity_type').eq('id', id).maybeSingle();
    if (list.error) throw list.error;
    if (!list.data) return reply.code(404).send({ error: 'not_found' });
    const entityType = list.data.entity_type as EntityType;

    const rows = dedupeRowsByConflict(matches.map((m) => toRow(entityType, organizationId, m)));
    const upserted = await db
      .from(TABLE[entityType])
      .upsert(rows, { onConflict: 'organization_id,provider,external_id' })
      .select('id');
    if (upserted.error) throw upserted.error;

    const memberRows = (upserted.data ?? []).map((r) => ({
      organization_id: organizationId,
      list_id: id,
      entity_type: entityType,
      entity_id: r.id as string,
    }));
    if (memberRows.length > 0) {
      const mem = await db.from('list_members').upsert(memberRows, {
        onConflict: 'list_id,entity_type,entity_id',
        ignoreDuplicates: true,
      });
      if (mem.error) throw mem.error;
    }
    return reply.code(201).send({ added: memberRows.length });
  });

  app.delete('/lists/:id/members/:memberId', async (request, reply) => {
    const { db } = requireAuth(request);
    const { id, memberId } = MemberParam.parse(request.params);
    const { error } = await db.from('list_members').delete().eq('list_id', id).eq('id', memberId);
    if (error) throw error;
    return reply.code(204).send();
  });
};
