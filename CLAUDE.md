# Velora Backend (this repo only; frontend is separate, over HTTP)
## Stack (locked — ask before changing)
TS ESM ("type":"module") · Fastify 5 · Zod · tsx (dev)/tsup (build), Node 20+
Supabase (Postgres+RLS) · Inngest · LangGraph — later phases. Deploy: Railway
## Rules that change behavior
- Entry src/api/server.ts; routes src/api/routes/; config src/config/.
- Validate ALL env vars in src/config/env.ts via Zod; never read process.env elsewhere.
- Every table gets Row-Level Security in its first migration (multi-tenant).
- credit_ledger and suppression_list exist from day one.
- NEVER commit .env or print secrets; service-role key is backend-only.
- Run `pnpm typecheck` after changes. Small, reviewable commits.
## Commands
pnpm dev · pnpm build · pnpm start · pnpm typecheck