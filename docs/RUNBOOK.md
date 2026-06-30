# Velora — go-live runbook

The single source of truth for deploying Velora and turning real sending on. Read it top to
bottom before a first deploy. The order matters: **nothing sends a real email until the very
last step (§7), and that step is a deliberate, per-org act.**

This repo (`velora_backend`) owns everything dangerous — the database, the org sending flags, the
background jobs, and the go-live flip. The dashboard (`velora_frontend`) can read and one-click
**PAUSE**; it cannot turn sending on, by design (see §7).

---

## 1. The honesty contract

Velora never fabricates an outcome. A feature is exactly one of:

| Class | Meaning |
|-------|---------|
| ✅ **FULLY BUILT** | Real end-to-end. A genuine `0` is real data, not a placeholder. |
| 🟡 **DRY-RUN** | The full pipeline runs but stops at the wire — recorded as `status='dry_run'`, **no real email leaves** — until the §7 flip. |
| 🟨 **HONEST SHELL** | The surface is real; the external leg is deferred and **says so** (never a fake success). |
| 🔌 **EXTERNAL / not connected** | A seam exists but no provider is wired. Returns honest "not configured" / empty — an intentional deferral, not a bug. |

**Per-area map (what a reader/operator should expect):**

- ✅ 5-type campaign builder + sequences + A/Z variants; grounded drafting + verification (when an LLM key is funded); tasks/approval queue; analytics hub; team management + sender config; dialer queue + manual call log (**the agent never dials**); intent-signal catalog (4 live definitions, 8 coming-soon); billing / credit-ledger + 14-quest onboarding; copilot (**propose → human confirms** every write); compliance audit log; self-serve signup + org provisioning.
- 🟡 **The entire send engine** — cold send, reply send, the multi-step follow-up sequencer, and all autonomy — is **structurally dry-run until the §7 flip**. Every "send" is recorded as `status='dry_run'`; no real email goes out.
- 🟨 Team invitations (real pending invite + copyable link; **no email is sent**, accept+signup deferred); dialer-brief talking points (no LLM → honest `{unavailable}`, never a guessed script); CRM OAuth connect (`not_configured` without provider creds).
- 🔌 Website-visitor de-anon resolver; CRM sync client; softphone dialing; LinkedIn / multi-channel; the email-sending substrate (Smartlead) and the LLM providers are **BYOK** — supply keys to activate. ⚠️ The Anthropic key is currently **exhausted**, so live drafting 400s until it is topped up — a billing state, not a code bug.

---

## 2. Architecture

Two **separate** git repos that talk only over HTTP — never cross-import, never one commit across both.

```
velora_frontend (Next.js, App Router)  ──HTTP──▶  velora_backend (Fastify 5, Node ≥22)
        │ Vercel                                          │ Railway
        └──────────────┬───────────────────────────────┬─┘
                       ▼                                 ▼
            Supabase (Postgres + RLS + pgvector)   Inngest Cloud (crons + events)
                  one project, shared by both
```

- **Backend → Railway.** Build `pnpm build` (tsup → `dist/`), start `pnpm start` (`node dist/api/server.js`). The server binds `HOST=0.0.0.0` and Railway's `$PORT` automatically — no Procfile or Nixpacks config needed.
- **Frontend → Vercel.** Standard Next.js build.
- **Supabase.** Postgres with Row-Level Security on every table; both repos use the same project (the frontend with the anon key under RLS, the backend additionally with the service-role key).
- **Inngest Cloud.** Runs the crons and event-driven jobs (§5). The backend exposes the Inngest serve handler; it must be **registered** or none of it runs.

---

## 3. Backend deploy — Railway

### 3.1 Required env (the server hard-fails at boot without these)
**First set `NODE_ENV=production`** — it *arms* the fail-loud gate. ⚠️ It is not itself checked: it
defaults to `development`, so if you forget it the server boots green but **silently skips every
production check below** (the more dangerous failure mode). With it set, `src/config/env.ts`
**refuses to boot** (exit 1, naming the offender) if any of the following is missing — so a
misconfigured deploy fails loudly instead of booting green-but-dead:

| Var | Why it's required in prod |
|-----|---------------------------|
| `SUPABASE_URL` | DB + auth. |
| `SUPABASE_ANON_KEY` | RLS-scoped client. |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend-only privileged client. **Never expose to the frontend.** |
| `INNGEST_SIGNING_KEY` | Verifies inbound Inngest calls. Missing → crons/jobs silently dead. |
| `INNGEST_EVENT_KEY` | Lets the app emit Inngest events. |
| `CORS_ORIGIN` | Must be your **exact** Vercel origin, **not** the `*` default (the `*` is also rejected at boot in prod, and it breaks the CRM OAuth callback redirect target). |

### 3.2 Optional / feature-gated env
Absent → the named feature stays honestly off; the server still boots.

| Var | Absent → |
|-----|----------|
| `ANTHROPIC_API_KEY` | Live drafting/copilot 400. ⚠️ currently **exhausted — top up**. |
| `OPENAI_API_KEY` | KB embeddings disabled; dialer-brief KB block is skipped (honest `kbChunks=[]`, never a 500). |
| `DEEPSEEK_API_KEY` (+ `DEEPSEEK_BASE_URL`) | Cheap-tier model unavailable. |
| `FIRECRAWL_API_KEY` | KB web ingestion off. |
| `SMARTLEAD_API_KEY` / `SMARTLEAD_API_URL` / `SMARTLEAD_WEBHOOK_SECRET` | No sending substrate / no inbound webhook verification. **Required before §7 go-live.** |
| `MILLIONVERIFIER_API_KEY` | Email verification skipped (the send gate fails closed when it can't verify). |
| `LEAD_PROVIDER` (default `seed`) / `APOLLO_API_KEY` | Lead sourcing stays on the free deterministic **seed** fixture (zero spend). Set `LEAD_PROVIDER=apollo` **and** `APOLLO_API_KEY` (BYOK) to source real leads via Apollo — metered. Forgetting the key can never silently charge (the seam falls back to seed). |
| `LEAD_SEARCH_COST` (1) / `LEAD_DAILY_CAP_PER_ORG` (25) / `LEAD_DAILY_CAP_GLOBAL` (100) | Spend guardrail for metered lead search: 1 credit debited per successful search + a per-org & global daily search quota. Seed is never metered. |
| `DKIM_SELECTOR` | DKIM stays honestly `unknown` (never a fabricated pass); SPF + DMARC still verify. |
| `SIGNUP_GRANT_CREDITS` (default 200) | Welcome credit grant on new-org provisioning; set `0` to disable. |
| `WEBSITE_VISITOR_RESOLVER_API_KEY` | De-anon resolver off (visits recorded, never resolved). |
| `HUBSPOT_*` / `SALESFORCE_*` / `OAUTH_STATE_SECRET` | CRM connect returns `not_configured`. |
| `DAILY_SEND_CAP_PER_ORG` (50) / `DAILY_SEND_CAP_GLOBAL` (200) | Velora-side daily send ceilings (governor). |
| `ANOMALY_BOUNCE_RATE` (0.05) / `ANOMALY_MIN_SENDS` (20) / `ANOMALY_MAX_COMPLAINTS` (0) / `ANOMALY_WINDOW_HOURS` (24) | Circuit-breaker thresholds that auto-pause autonomy on a breach. |

---

## 4. Database migrations

The build does **not** apply migrations — run them explicitly against the prod DB. There are **29**
migrations through `20260704000000_lead_search_reason.sql` (the last two add the org-delete owner-guard
exemption and the `lead_search` credit_ledger reason that live Apollo metering depends on). Every table
carries RLS from its first migration.

Non-interactive push (password from your env, **never** printed):

```bash
# PW comes from your local .env / shell, not the command line
printf 'y\n' | NODE_OPTIONS=--use-system-ca pnpm exec supabase db push \
  --db-url "postgresql://postgres:${PW}@db.<project-ref>.supabase.co:5432/postgres"
```

(`NODE_OPTIONS=--use-system-ca` is only needed behind a TLS-intercepting corporate proxy; harmless otherwise.)
After pushing, sanity-check that the latest migration name above is the newest applied.

---

## 5. Inngest registration (do not skip)

Register the deployed Railway serve URL with Inngest Cloud, or **all background work is silently dead**
(no signal monitoring, no de-anon sweep, no anomaly circuit-breaker, no CRM sync, no retention purge,
and no campaign execution).

**Crons (UTC):**

| Function | Schedule | Job |
|----------|----------|-----|
| `signal-monitor` | `*/5 * * * *` | poll intent-signal subscriptions, enroll on a fire |
| `website-visitor-monitor` | `*/10 * * * *` | de-anon sweep (no-op until a resolver is wired) |
| `anomaly-monitor` | `*/15 * * * *` | self-protection circuit-breaker → auto-pause on breach |
| `crm-sync-monitor` | `*/30 * * * *` | CRM dormant sync (no-op until a CRM is connected) |
| `retention-purge` | `0 2 * * *` (daily 02:00) | data-retention purge per org policy |

**Event-driven (not crons):** `campaign-executor` and `campaign-followup` fire on enrollment / sequence
events. Same Inngest registration; nothing extra to schedule.

---

## 6. Frontend deploy — Vercel

The three `NEXT_PUBLIC_*` vars are **inlined at build time** — set them in the Vercel project
**before the first build**, and a change requires a rebuild. See `velora_frontend/.env.example`.

| Var | Missing → |
|-----|-----------|
| `NEXT_PUBLIC_SUPABASE_URL` | The whole site errors (the auth proxy gate throws). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` bakes into the bundle — broken API calls **and** a localhost pixel snippet shown to customers. Set it to the Railway origin. |

---

## 7. ★ Go-live — the deliberate two-flag flip

**Velora ships dry-run-safe.** Each org row defaults to `sending_enabled = false` and
`sending_dry_run = true`, and `assertLiveSendAllowed` (`src/lib/sending-mode.ts`) makes a real send
**structurally impossible** until **both** flags flip — every other combination throws `409
sending_disabled` at the send chokepoint. Until you do this, every approved/auto send is recorded as
`status='dry_run'` and **no real email is delivered**.

The flip is a **privileged service-role act, never a UI route.** The `organizations` table has only a
SELECT policy (no authenticated UPDATE) — a regression test (`src/integration/send-rls-guard.test.ts`)
asserts an org owner *cannot* flip these flags, so a future migration that accidentally added an UPDATE
policy would fail CI. The dashboard exposes **read + one-click PAUSE only**.

**Procedure (per org, one at a time, deliberate):**

1. Run the QA playbook (§8) end-to-end **in dry-run** and confirm every expected result.
2. Confirm the sending substrate is configured: `SMARTLEAD_API_KEY` and `MILLIONVERIFIER_API_KEY`
   are set (the gate fails closed without verification).
3. **★ HARD PREREQUISITE — inbound webhook (audit F-RT4). Do NOT flip sending on until this is green.**
   Set **`SMARTLEAD_WEBHOOK_SECRET`** *and* register the Smartlead webhook to POST
   `https://<railway-origin>/webhooks/smartlead`. Runtime-verified: with the secret unset, the route
   returns **`503 webhook_unconfigured` and drops every inbound event**. If you flip sending on without
   this, you would send real email but **never process replies / bounces / unsubscribes** — which
   silently disables **suppression-on-reply, halt-on-reply, and the bounce/complaint anomaly
   circuit-breaker**. You would keep emailing people who already replied, unsubscribed, or hard-bounced.
   Confirm a test webhook delivers (a `200`, not `503`) before proceeding.
4. Flip the two flags via the Supabase SQL editor (or a service-role client):

   ```sql
   update public.organizations
      set sending_enabled = true,
          sending_dry_run  = false
    where id = '<org-uuid>';   -- one specific org, never a blanket update
   ```

From this point that org's sends are real and subject to every guard still in force: suppression
re-check, email verification (fail-closed), warm-mailbox-only, the per-org + global volume governor,
campaign-pause, sender-pause, and credit balance.

---

## 8. QA playbook — pre-go-live smoke (run in dry-run)

Each row: do the action, confirm the honest expected result. All of this runs **before** the §7 flip.

| Check | Expected (honest) result |
|-------|--------------------------|
| `GET /health` | `{ status: "ok", uptime, version }`. |
| Log in; load the dashboard | Only your org's rows (RLS); a fresh org shows genuine `0`s, not fake data. |
| Create a campaign of each type (cold / warm / cross-sell / website-visitor / intent) | All five create; intent needs no list. |
| Enroll a lead → drafting | A draft/task is produced (or the safe template when verified facts are thin — never a guess). |
| **Approve a draft** | The outbound row is **`status='dry_run'`** — confirm in `outbound_messages`. No real email. |
| Suppression | A suppressed address is skipped at the chokepoint. |
| Volume governor / sender-pause / campaign-pause | A paused sender/campaign and an over-cap org are blocked. |
| Reply ingest | An inbound reply suppresses the person globally and halts their sequence. |
| Analytics | Reply/positive rates stay honest-empty until there are real sends (`realSends > 0`). |
| Credits | Metered actions debit `credit_ledger` (`enrichment`, `send`, `reply`, `website_visitor_identification`); grants post as `signup_grant` / `quest_reward` / `top_up`. |

---

## 9. Kill-switch & rollback

- **Pause autonomy now:** `POST /autonomy/pause` — safe, one-click, audited (also surfaced in the dashboard).
- **Stop all real sending:** flip the two flags back via service-role —
  `update public.organizations set sending_enabled = false, sending_dry_run = true where id = '<org-uuid>';`.
  The system returns to recording dry-runs instantly.
- **Automatic:** the `anomaly-monitor` circuit-breaker auto-pauses an org's autonomy when bounces/complaints breach the thresholds (§3.2).
- **Code rollback:** redeploy the previous Railway / Vercel build. Migrations are **forward-only** — never hand-edit an applied migration; add a new one.
