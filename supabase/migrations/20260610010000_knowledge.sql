-- 0002 knowledge.sql — Slice 1: knowledge base + grounding foundation.
-- Conventions mirror 0001: org-scoped RLS via public.auth_organization_id(),
-- set_updated_at() on mutable tables. Tables created before the function that
-- references them (LANGUAGE sql bodies are validated at CREATE time).

create extension if not exists vector;  -- pgvector (mirrors 0001 citext handling)

-- kb_documents — one row per source. Written by ingest job (service-role); read by org.
create table public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null default 'website' check (kind in ('website', 'upload', 'manual')),
  source_url text,
  title text,
  raw_text text,
  status text not null default 'pending'
    check (status in ('pending', 'scraping', 'chunking', 'embedding', 'ready', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index kb_documents_organization_id_idx on public.kb_documents(organization_id);
create trigger kb_documents_set_updated_at before update on public.kb_documents
  for each row execute function public.set_updated_at();
alter table public.kb_documents enable row level security;
create policy "org members read kb_documents" on public.kb_documents
  for select to authenticated using (organization_id = public.auth_organization_id());
-- writes: service-role only (ingest job)

-- kb_chunks — embedded chunks; org_id denormalized for RLS + filtering.
-- Append-only per ingest (re-ingest deletes+reinserts). Written by job; read by org.
create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kb_document_id uuid not null references public.kb_documents(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536),
  token_count int,
  content_hash text not null,
  embedding_model text not null,
  embedding_version text not null default 'v1',
  created_at timestamptz not null default now()
);
create index kb_chunks_organization_id_idx on public.kb_chunks(organization_id);
create index kb_chunks_kb_document_id_idx on public.kb_chunks(kb_document_id);
create index kb_chunks_embedding_hnsw_idx
  on public.kb_chunks using hnsw (embedding vector_cosine_ops);
alter table public.kb_chunks enable row level security;
create policy "org members read kb_chunks" on public.kb_chunks
  for select to authenticated using (organization_id = public.auth_organization_id());
-- writes: service-role only (ingest job)

-- coaching_points — user-editable; full CRUD under RLS.
create table public.coaching_points (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index coaching_points_organization_id_idx on public.coaching_points(organization_id);
create trigger coaching_points_set_updated_at before update on public.coaching_points
  for each row execute function public.set_updated_at();
alter table public.coaching_points enable row level security;
create policy "cp read"   on public.coaching_points for select to authenticated using (organization_id = public.auth_organization_id());
create policy "cp insert" on public.coaching_points for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "cp update" on public.coaching_points for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "cp delete" on public.coaching_points for delete to authenticated using (organization_id = public.auth_organization_id());

-- proof_items — user-editable; full CRUD under RLS.
create table public.proof_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category text not null check (category in ('highlight', 'customer', 'case_study')),
  title text not null,
  body text,
  url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index proof_items_organization_id_idx on public.proof_items(organization_id);
create trigger proof_items_set_updated_at before update on public.proof_items
  for each row execute function public.set_updated_at();
alter table public.proof_items enable row level security;
create policy "pi read"   on public.proof_items for select to authenticated using (organization_id = public.auth_organization_id());
create policy "pi insert" on public.proof_items for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "pi update" on public.proof_items for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "pi delete" on public.proof_items for delete to authenticated using (organization_id = public.auth_organization_id());

-- icp_profiles — created here; populated in Slice 2. Full CRUD under RLS.
create table public.icp_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  definition jsonb not null default '{}'::jsonb,
  source text not null default 'manual' check (source in ('manual', 'ai_suggested')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index icp_profiles_organization_id_idx on public.icp_profiles(organization_id);
create trigger icp_profiles_set_updated_at before update on public.icp_profiles
  for each row execute function public.set_updated_at();
alter table public.icp_profiles enable row level security;
create policy "icp read"   on public.icp_profiles for select to authenticated using (organization_id = public.auth_organization_id());
create policy "icp insert" on public.icp_profiles for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "icp update" on public.icp_profiles for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "icp delete" on public.icp_profiles for delete to authenticated using (organization_id = public.auth_organization_id());

-- match_kb_chunks — cosine KNN, explicitly scoped to one org.
-- SECURITY INVOKER (default): RLS also applies for user-scoped calls; the explicit
-- org filter scopes service-role (Researcher job) calls too. Defense in depth.
create or replace function public.match_kb_chunks(
  p_org_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 8
)
returns table (id uuid, kb_document_id uuid, content text, similarity float)
language sql
stable
set search_path = public, extensions
as $$
  select c.id, c.kb_document_id, c.content,
         1 - (c.embedding <=> p_query_embedding) as similarity
  from public.kb_chunks c
  where c.organization_id = p_org_id and c.embedding is not null
  order by c.embedding <=> p_query_embedding
  limit greatest(p_match_count, 1)
$$;
