# Velora — backend

The API, agents, and background jobs for Velora (an honest autonomous-BDR platform). This is a
**separate repo** from `velora_frontend`; the two communicate only over HTTP. Deployed to **Railway**.

## Stack (locked)

TypeScript ESM · **Fastify 5** · **Zod** · `tsx` (dev) / `tsup` (build) · **Node 20+**
**Supabase** (Postgres + Row-Level Security, multi-tenant) · **Inngest** (crons + durable jobs)
Lead data: Apollo (BYOK) · Email: Smartlead · Verification: MillionVerifier · LLM: Anthropic / OpenAI / DeepSeek

## Layout

- `src/api/server.ts` — entry; `src/api/routes/` — every HTTP route (one plugin per file).
- `src/agents/` — drafting (research → ground → write → verify), the **sending pipeline** (the dry-run
  chokepoint), reply handling, compliance.
- `src/integrations/` — `leads/` (Apollo + seed seam), `smartlead/` (+ sandbox), `verifier/`
  (MillionVerifier), `embeddings/`.
- `src/workers/inngest/` — crons (signal / website-visitor / anomaly / crm-sync monitors, retention
  purge) + the campaign executor / follow-up.
- `src/config/env.ts` — the **only** place `process.env` is read; every var is Zod-validated.
- `supabase/migrations/` — forward-only SQL; **RLS on every table from its first migration**.

## Safety model (do not weaken)

- **Two-flag send invariant:** a real email is sent only when `organizations.sending_enabled` **and**
  `!sending_dry_run` — both default safe, flippable by service-role SQL only (`organizations` is
  SELECT-only under RLS). Everything else dry-runs. Enforced at the `executeSend` chokepoint
  (`src/lib/sending-mode.ts`).
- **No fabrication:** drafts must pass deterministic verification or fall back to a safe template;
  integrations fail safe (honest error / sandbox / seed), never invent data.
- `credit_ledger` + `suppression_list` exist from day one; spend is metered + guard-railed.

## Commands

```bash
pnpm dev         # tsx watch (http://localhost:8080)
pnpm build       # tsup → dist/
pnpm start       # run the build
pnpm typecheck   # tsc --noEmit
pnpm lint        # biome check
pnpm test        # vitest (DB integration tests gated behind RUN_DB_IT=1)
```

On Windows behind a TLS-intercepting proxy, prefix Node commands with `NODE_OPTIONS=--use-system-ca`.

## Configuration & go-live

Copy `.env.example` → `.env` and fill the validated vars (see `src/config/env.ts`). In production the
env gate is fail-loud (boot is rejected if required vars are missing or `CORS_ORIGIN=*`).

Going live (mailbox warm-up, the deliberate two-flag flip, webhook registration) is an explicit,
documented operational act — see **[`docs/RUNBOOK.md`](docs/RUNBOOK.md)**. Project rules live in
`CLAUDE.md`; the product spec in `SPEC.md`.
