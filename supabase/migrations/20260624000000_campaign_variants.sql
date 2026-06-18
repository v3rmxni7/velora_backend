-- 0017 campaign_variants.sql — Phase 4 Slice 4.4: A/Z message variants.
-- A campaign can carry up to a few message VARIANTS (A/B/…); each variant is a short steering
-- "angle" (e.g. 'lead with the pain point') that rides the grounded Writer's coaching[] array —
-- NEVER fabricated copy. A lead is assigned ONE variant for the whole campaign (the cohort), set
-- once at enroll time. Per-variant performance is DERIVED from messages (no counters here).
-- Mirrors the campaigns/campaign_steps quartet (org-scoped RLS via auth_organization_id(),
-- set_updated_at() trigger). Create campaign_variants BEFORE the enrollments.variant_id FK.

create table public.campaign_variants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  -- A short steering angle (not a sentence sent verbatim). Capped to guard token bloat.
  angle text not null check (length(trim(angle)) > 0 and length(angle) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, label)
);
create index campaign_variants_campaign_id_idx on public.campaign_variants(campaign_id);
create index campaign_variants_organization_id_idx on public.campaign_variants(organization_id);
create trigger campaign_variants_set_updated_at before update on public.campaign_variants
  for each row execute function public.set_updated_at();
alter table public.campaign_variants enable row level security;
create policy "cv read"   on public.campaign_variants for select to authenticated using (organization_id = public.auth_organization_id());
create policy "cv insert" on public.campaign_variants for insert to authenticated with check (organization_id = public.auth_organization_id());
create policy "cv update" on public.campaign_variants for update to authenticated using (organization_id = public.auth_organization_id()) with check (organization_id = public.auth_organization_id());
create policy "cv delete" on public.campaign_variants for delete to authenticated using (organization_id = public.auth_organization_id());

-- enrollments cohort link. Nullable → a no-variant campaign keeps variant_id NULL (the cold path,
-- byte-identical drafts). ON DELETE SET NULL: removing a variant detaches its enrollments (they
-- fall back to the cold draft) rather than cascading their deletion.
alter table public.enrollments
  add column variant_id uuid references public.campaign_variants(id) on delete set null;
create index enrollments_campaign_variant_idx on public.enrollments(campaign_id, variant_id);
