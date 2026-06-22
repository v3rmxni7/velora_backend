-- F-RT5 (runtime finding): the last-owner guard `assert_org_has_owner` (Slice 4.8, migration
-- 20260628000000) correctly prevents demoting/removing an org's SOLE owner (no lockout). But it
-- ALSO made deleting an organization impossible: the org-delete cascade removes the owner's
-- membership row, the AFTER trigger then sees zero remaining owners, and raises `org_must_retain_owner`.
-- That blocks account closure / GDPR right-to-erasure / ops cleanup.
--
-- Fix: only enforce the guard when the organization itself still EXISTS. When the org row is being
-- deleted (it's already gone by the time this AFTER trigger fires), allow the cascade to remove the
-- owner membership. The lockout protection on a LIVE org is unchanged. The trigger definition
-- (`users_retain_owner`, AFTER UPDATE OR DELETE on public.users WHEN old.role='owner') is untouched —
-- only the function body changes.
create or replace function public.assert_org_has_owner()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.organizations where id = old.organization_id)
     and not exists (
       select 1 from public.users where organization_id = old.organization_id and role = 'owner'
     )
  then
    raise exception 'org_must_retain_owner' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;
