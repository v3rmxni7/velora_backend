-- 0020 website_visits_failed_status.sql — Phase 4 Slice 4.6 follow-up. The 0019 status CHECK omitted
-- 'failed', but processVisit marks a visit 'failed' when resolution errors (or the cross-tenant guard
-- trips). Without it, markFailed's update is silently rejected → the visit sticks in 'resolving' and
-- the error is never recorded. Widen the CHECK to include 'failed' (fix-forward; 0019 is already
-- applied). The constraint name is Postgres's default for the inline column check.
alter table public.website_visits drop constraint if exists website_visits_status_check;
alter table public.website_visits add constraint website_visits_status_check
  check (status in ('new', 'resolving', 'identified', 'unresolved', 'failed'));
