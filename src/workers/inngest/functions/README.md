# Inngest functions — idempotency convention

Every job is idempotent so a retry never double-charges a provider or double-emails a prospect.

**Producers** build a deterministic dedupe key and put it on the event payload:

```
dedupeKey = "{jobType}:{organizationId}:{entityId}:{logicalStep}"
```

**Two layers of protection:**

1. **Inngest** — each function sets `idempotency: 'event.data.dedupeKey'`, collapsing
   duplicate deliveries of the same key within a 24h window.
2. **Database** — any billable write inserts into `credit_ledger` with a unique
   `idempotency_key`. The unique constraint makes the charge idempotent *permanently*,
   even past Inngest's 24h window.

All four functions here are Phase 0 stubs (`step.run('noop', ...)`); real bodies land in
later phases. The serve HTTP handler is not mounted until Phase 1 (needs signing keys).
