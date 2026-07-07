-- S2 — gate + audit the mailbox warmup-override. warmup_override (and a direct status='warm') GRANT
-- send-eligibility to a mailbox without the warm-up proof — a send-safety attestation that must be an
-- OWNER act. The route adds requireRole('owner'), but mailboxes has a broad authenticated UPDATE RLS
-- policy (mb update), so a member could bypass the route and set warmup_override / status='warm'
-- directly via PostgREST. This DB trigger is the REAL boundary: it enforces owner-only at the row
-- level, regardless of code path.
--
-- Guarded transitions (the "grant send-eligibility" direction only): setting warmup_override -> true,
-- and setting status -> 'warm'. The status guard EXEMPTS rows where warmup_override is true, so the
-- legitimate warm-up sync (syncMailboxes re-asserts status='warm' WHERE warmup_override=true, under the
-- caller's client) is never blocked. Service-role writes (auth.uid() null — the Inngest warm-up refresh
-- + seed) bypass entirely. The SAFE direction (clearing the override, downgrading status) is unguarded.
create or replace function public.enforce_owner_mailbox_send_eligibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_owner boolean;
begin
  -- Trusted service-role writes have no end-user JWT.
  if auth.uid() is null then
    return new;
  end if;

  if (tg_op = 'INSERT' and new.warmup_override is true)
     or (tg_op = 'UPDATE' and new.warmup_override is true and old.warmup_override is distinct from true)
     or (new.status = 'warm'
         and (tg_op = 'INSERT' or old.status is distinct from 'warm')
         and new.warmup_override is not true) then
    select exists (
      select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'
    ) into is_owner;
    if not is_owner then
      raise exception 'granting a mailbox send-eligibility (warmup_override / warm status) requires the owner role'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists mailboxes_owner_send_eligibility on public.mailboxes;
create trigger mailboxes_owner_send_eligibility
  before insert or update on public.mailboxes
  for each row execute function public.enforce_owner_mailbox_send_eligibility();

-- Audit kind for the owner-gated attestation (folded-in; established widening pattern).
alter table public.audit_logs drop constraint if exists audit_logs_kind_check;
alter table public.audit_logs add constraint audit_logs_kind_check check (kind in (
  'team_role_changed', 'team_member_removed', 'sender_status_changed',
  'suppression_added', 'copilot_action_confirmed', 'domain_verified',
  'postal_address_updated', 'sending_go_live', 'sending_paused',
  'mailbox_warmup_override_set', 'retention_reported', 'retention_purged'
));
