-- 0022 team_sender_config.sql — Phase 4 Slice 4.8: team management + full sender config.
-- (A) Let org members READ their co-members (the Team list); writes to users stay service-role only.
-- (B) team_invitations — honest-shell invites (pending record + a hashed token; the accept route +
--     signup UI are a DEFERRED onboarding slice — there is no signup flow and no SMTP yet).
-- (C) at-most-one-primary-mailbox-per-sender, DB-enforced.

-- (A) users: add a co-member SELECT policy (coexists with the existing "users read self"). RLS
-- policies OR together. No recursion: auth_organization_id() is SECURITY DEFINER (search_path=''), so
-- its internal read of public.users bypasses RLS and never re-triggers this policy. No write policy is
-- added — role changes + removals are service-role via authed, role-gated routes.
create policy "org members read users" on public.users for select to authenticated
  using (organization_id = public.auth_organization_id());

-- (B) team_invitations — org-scoped pending invites. role is admin|member only (never invite an
-- owner). token_hash = sha256(raw token); the raw token is returned ONCE to the inviter, never stored.
-- READ-only to authenticated (so the Team page lists pending invites); all writes are service-role.
create table public.team_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email citext not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  token_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid references public.users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index team_invitations_organization_id_idx on public.team_invitations(organization_id);
-- One LIVE (pending) invite per email per org; revoked/expired/accepted rows never block a re-invite.
create unique index team_invitations_pending_email_idx
  on public.team_invitations(organization_id, email) where status = 'pending';
create trigger team_invitations_set_updated_at before update on public.team_invitations
  for each row execute function public.set_updated_at();
alter table public.team_invitations enable row level security;
create policy "org members read invitations" on public.team_invitations for select to authenticated
  using (organization_id = public.auth_organization_id());

-- Last-owner guard (DB-enforced, the atomic backstop for the role-change + remove routes): an org
-- must always retain at least one owner. Fires only when an OWNER row is demoted or deleted; if the
-- org then has zero owners, raise — so demoting/removing the sole owner is impossible (no lockout).
create or replace function public.assert_org_has_owner()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from public.users where organization_id = old.organization_id and role = 'owner'
  ) then
    raise exception 'org_must_retain_owner' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
create constraint trigger users_retain_owner
  after update or delete on public.users
  for each row when (old.role = 'owner')
  execute function public.assert_org_has_owner();

-- (C) at-most-one-primary mailbox per sender (DB invariant backstop for the atomic set-primary write).
-- Partial: only is_primary rows with a sender are constrained; unassigned (sender_id null) rows never
-- collide, and a sender may legitimately have zero primaries.
create unique index mailboxes_one_primary_per_sender
  on public.mailboxes(sender_id) where is_primary = true and sender_id is not null;
