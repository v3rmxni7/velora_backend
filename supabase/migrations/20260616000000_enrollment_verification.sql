-- 0010 enrollment_verification.sql — Phase 2 Slice 2.4: persist the email-verification verdict.
-- Stored at prepare time so the send (2.5) records the ACTUAL verdict (deliverable | risky) in
-- its gates blob, not just a verified boolean. 'skipped' = no verifier configured. NULL = not run.
alter table public.enrollments
  add column verification text
    check (verification is null or verification in ('deliverable', 'risky', 'skipped'));