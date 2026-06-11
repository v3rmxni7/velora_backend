# AI Sales Agent (Velora) — Master Build Plan / SPEC

> The definitive end-to-end spec for Velora, an autonomous AI BDR product. This file is the **source of truth** — read it first. It folds in a complete reverse-engineering of the competitor dashboard (Artisan/Ava, captured from a live trial): full navigation, every module, the sender model, the knowledge/coaching/proof layer, the signal catalog, the website-visitor flow, the approval and reply surfaces, the agentic copilot, the credits economy, and the gamified onboarding.
>
> **Scope & IP.** Velora replicates the product *category* under its own brand and identity — workflow, capability, and experience — never the competitor's name, logo, copy, or visual skin. Every heavy input (contact data, sending infrastructure, models, intent feeds) is rented from the same kind of providers any competitor uses.
>
> Supporting research lives in `docs/research/`; competitor screenshots in `docs/artisan-screenshots/`. _Figures are 2026 market ranges; verify before relying on them._

---

## Contents

1. Executive Summary & Strategic Thesis
2. Critical Clarification — Claude Max (dev tool) vs. the Product API (a cost center)
3. Complete Product Specification (module by module)
4. System Architecture
5. Technology Stack (locked) & Repo Structure
6. Product LLM / API Strategy — chosen calculatively
7. Core Data Model
8. Phased Delivery Plan (every module mapped)
9. The Hard Problems & Realistic Ceiling
10. Unit Economics & Pricing
11. UI/UX & Design System
12. Compliance & Trust
13. Risk Register
14. Decisions Locked / Open & Immediate Next Steps

---

## 1. Executive Summary & Strategic Thesis

**The thesis:** this is a **data-and-deliverability product that uses AI to write the words** — not an "AI project." The language model is the smallest, cheapest, least differentiating layer. Value lives in orchestration: pulling the right leads, grounding every message in verified facts, reaching the inbox, and reacting correctly to replies. Every hard problem follows from this.

**The 80 / 20 reality.** ~80% of the product is straightforward and shippable in weeks. The final 20% — inbox deliverability, data accuracy, reply quality at scale — is where the difficulty, cost, and risk concentrate, and it cannot be matched by code or budget alone; it is made of time, accumulated outcome data, and earned sender reputation. No competitor shortcuts it either.

### Headline figures

- **Realistic ceiling:** ~85–90% feature & UX parity; ~60–75% performance parity at launch, closing as domains age and outcome data accrues.
- **Cost to serve a typical customer (10K leads/mo):** ~$500–$1,100/month, dominated by data and email infrastructure — not AI.
- **Per-lead variable cost:** ~$0.03–$0.08 fully processed; the AI portion is ~$0.015–$0.02 of that.
- **The wedge:** incumbents price at ~$1,500–$2,000/customer and $150–$400/user. We undercut hard, profit, and pair it with a faster, clearer front end.

---

## 2. Critical Clarification — Claude Max vs. the Product API

Two separate things; never conflate them in budgeting or architecture:

- **Claude Max — the development tool.** A fixed monthly subscription used to write the code (Claude Code). Developer overhead, like an IDE. NOT in product running cost, does NOT scale with customers/leads, and is NOT the model the product calls at runtime.
- **The Product API — a variable cost center.** The model(s) the deployed product calls on every lead and reply. Scales directly with usage; chosen per task, calculatively, to minimize spend while protecting quality (Part 6). May be Anthropic, Google, OpenAI, or DeepSeek — routed by task, with failover. Real COGS inside unit economics.

> Consequence: optimizing the product API (routing, caching, batching, output caps) is a margin lever (Parts 6 & 10). The Claude Max subscription is excluded from every cost figure here by design.

---

## 3. Complete Product Specification

Reverse-engineered from the live competitor dashboard. This is the functional source of truth: build to match this, under our own identity. Each module lists what it does and the build notes (build vs. buy, data dependencies).

### 3.0 Global application shell

Collapsible left sidebar grouped into four sections; persistent footer; top trial/upgrade banner; a BETA-style product badge.

| Nav group | Items |
|---|---|
| Manage | Manage Ava · Campaigns · Analytics · Team |
| Engage | Inbox · Tasks · Dialer |
| Lead discovery | Find leads · Signals · Website visitors |
| Lead management | Lists · Leads |
| Footer (persistent) | Chat with the agent (copilot) · Credits balance + usage bar · Support · user/org menu |

**Build:** a single app-shell layout (config-driven nav, collapsible), a global Credits context provider (live balance + low-balance state), and a plan/trial-driven banner. Everything below renders inside this shell.

> Note: in Velora the in-product agent does not have to be named "Ava." Use our own assistant name; the module names above are functional, not branding.

### 3.1 Manage (agent control center)

Four tabs: Overview · Outbound sequences · Autonomous replies · Guardrails.

- **Overview:** a gamified Onboarding quests card (X/14 complete) where each quest pays credits — e.g. connect primary mailbox (+200), set up email signature (+200), launch a signal-based campaign (+200), add secondary mailboxes (+1000), turn on autopilot (+400), and 9 more. Below it, "recent progress" (the four KPIs: New leads enrolled, Messages sent, Positive responses, Meetings booked — each with a MoM delta and sender/date filters), and "Tasks the agent needs input on."
- **Outbound sequences → Knowledge:** the grounding layer, human-editable. Two parts — (1) Shared campaign coaching: coaching points applied to every campaign unless overridden per-campaign (add/edit/delete); (2) Shared proof & results: a curated library the agent may cite, split into Highlights / Customers / Case studies, each entry editable. A Default settings sub-tab holds global campaign defaults.
- **Autonomous replies:** configuration for how the agent replies on its own.
- **Guardrails:** the autonomy rules — escalation thresholds and the action allowlist, expressed as UI.

**Build:** this is the grounding + autonomy config surface. Maps to the KB + `coaching_points` + `proof_items` tables and a guardrails/policy config. The quests are an activation system tied to the credit ledger. "Autopilot" being a quest confirms autonomy is a milestone the customer graduates into.

### 3.2 Campaigns

Campaign list with status (Active / Paused / Draft). "New campaign" offers five types; one engine, differing by lead source + injected context:

| Campaign type | Lead source / purpose |
|---|---|
| Cold outbound | Net-new prospects from the database / Find leads |
| Warm outbound | Leads already in the customer's CRM |
| Cross-sell / upsell | Existing customers (CRM + product-usage context) |
| Website visitor | De-anonymized site visitors, then sequenced |
| Intent signals | Timely net-new prospects surfaced by a subscribed signal |

**Campaign builder tabs:** Targeting (audience source + filters/signal/list) · Sequence (steps, delays, channels) · Messaging (copy config, variants, coaching) · Senders (which sender(s) send it) · Settings (schedule, send caps, guardrail overrides). Then Launch.

**Build:** a single campaign engine with a `campaign_type` enum; the builder is a multi-step wizard writing to `campaigns` + `campaign_steps` + `campaign_variants`; audience resolves from a list, a signal subscription, a CRM segment, or the website-visitor feed.

### 3.3 Analytics

Five sub-views: Overview · Messaging · Deliverability · Dialer · Credits (deliverability and credit-burn are first-class — a deliberate trust signal).

- **KPI cards:** Leads contacted (New / All), Messages sent, Connections sent (+ acceptance rate), Responses (All / Positive, + response rate), Meetings booked. "Connections" confirms a LinkedIn/social channel runs alongside email.
- **Charts:** time series (toggle New leads contacted / Messages sent / All responses / Positive responses) and a performance breakdown by Campaign / Sender / Personalization type / channel / sequence.
- **Controls:** date range (e.g. 30D), granularity (Daily), Filters, Manage columns, and Export on every panel.

**Build:** event-sourced metrics off the messages/enrollments/threads tables; the Deliverability tab reads mailbox reputation (bounce/complaint/placement); the Credits tab reads the credit ledger. "Personalization type" as a dimension ties to A/Z testing.

### 3.4 Team (senders, mailboxes, sending capacity)

Two tabs: My team · Sender invite settings. A table of senders with columns: Name, Status, Campaigns, Primary mailbox, Secondary mailboxes, LinkedIn, Calendar, Dialer. Roles (Owner). Actions: Invite, Purchase mailboxes, Assign seat, Connect mailbox. An "Issues you can fix" banner surfaces problems (e.g. primary mailbox not connected).

**Build (schema-significant):** a **sender** entity sits between users and {primary mailbox, secondary mailboxes, LinkedIn, calendar, dialer seat}. Campaigns send "on behalf of" a sender, drawing on that sender's connected accounts. Includes roles/permissions and the secondary-mailbox purchase flow (buy lookalike-domain inboxes for volume).

### 3.5 Inbox (reply handling)

Unified, threaded reply management filtered by Needs action / No action / Sent, with search + filters and a thread view. "Needs action" = escalations the agent flagged; "No action" = handled autonomously; "Sent" = outbound.

**Build:** ingest replies (Gmail API / Microsoft Graph / IMAP) into a thread+message model; the reply classifier routes each to Needs action vs No action; a human reply UI handles escalations. This is one of TWO oversight surfaces — see Tasks.

### 3.6 Tasks (approval & work queue)

Three task types, each with a count badge: Outbound to approve (drafted messages awaiting human approval before send, with "Approve all"), Manual tasks (agent→human handoffs), Platform tasks (setup/config). Filters: All tasks / Pending / by lead/company/subject.

**Build:** the pre-send approval gate (used before autopilot) plus assigned work. Distinct from Inbox: Tasks = outbound approvals + handoffs; Inbox = inbound reply handling. Two separate surfaces, not one.

### 3.7 Dialer

Tabs: Ready to call · Upcoming · Call log. The agent does NOT call — it gives reps live talking points and summaries of past interactions and queues leads to dial. Gated behind paid dialer seats.

**Build (defer):** human dials; the agent generates call briefs; a call queue + softphone (Twilio Voice) later; seat-gated. Lower priority than the email loop.

### 3.8 Find leads

Search over 250M+ professionals. An entity-type dropdown (Professionals / companies / local) switches the target. Two modes: a natural-language semantic search AND a structured "Search with filters" builder. The page shows AI-generated ICP query suggestions personalized to the customer (read from their knowledge base).

**Build:** dual-mode search over rented data (Apollo / People Data Labs). NL → structured filters via an LLM; AI audience suggestions generated from the customer KB; a filter builder; results add to a List or enroll into a campaign. Buy the data, build the search/orchestration.

### 3.9 Signals (intent-signal catalog)

A categorized catalog of subscribable triggers — tabs All / Hiring / Funding / Other — with live vs. "Coming soon" states. Each subscription feeds an intent-signals campaign.

| Category | Signal | Status (observed) |
|---|---|---|
| Funding | Funding announcement (new round) | Live |
| Hiring | New leadership hire (C-level/VP/director) | Live |
| Hiring | First hire in department | Live |
| Hiring | First hire in role (new specialized position) | Live |
| Hiring | Hiring for role; First hire in country; Multiple open jobs | Coming soon |
| Other | Tech stack in job descriptions; Topic intent | Coming soon |
| Funding | Named investor backing; Top customer's investors | Coming soon |
| Other | Webhook — trigger outreach from any external system | Coming soon |

**Build:** a signal-subscription model — each signal is a monitor that emits events which auto-enroll matching leads into signal campaigns. Buy the feeds (funding via Crunchbase/Harmonic-type; hiring/job-change data; topic intent via Bombora). The Webhook signal = external-event ingestion. Ship the live four first; gate the rest behind "coming soon."

### 3.10 Website visitors

Per-domain de-anonymization (Select domain / Add domain → install pixel). Two tabs: People vs Companies. Metrics: Identified today / 7d / 30d. Identified visitors flow into outreach.

**Build:** a per-domain JS pixel; company-level resolution via reverse-IP (build) + person-level via an identity-graph API (buy, RB2B-style; resolves only ~5–20% of US traffic, US-centric, privacy-sensitive). Identification windows; feed the website-visitor campaign type. Mind GDPR/CCPA for person-level.

### 3.11 Lists

Saved / segmented lead lists used as campaign audiences and as import targets.

**Build:** a list entity with membership; usable as a campaign audience source and the destination for CSV import or Find-leads/Signals/Website-visitor results.

### 3.12 Leads (the working contact database)

Three entity types via tabs: People / Companies / Local business — matching the contact + local-business datasets. Search + filters; add/import.

**Build:** three record types (person / company / local business) holding saved + enriched records; populated from import and from Find leads, Signals, and Website visitors.

### 3.13 Chat with the agent (agentic copilot)

A second interaction modality layered over the structured app — available as a slide-out panel and a full-screen mode. Multi-thread chat history (Search chats, New chat). Contextual suggested actions that span the product: "Suggest audience personas for my business," "Compare performance across my campaigns," "Check my mailbox deliverability." Input supports slash commands ("/ for commands"), voice input (mic), and Enter / Shift+Enter.

**Build (distinctive):** an agent with tools bound to the app's capabilities — it can read analytics, propose ICPs from the KB, check deliverability, and trigger actions. Needs conversation threads, a slash-command → tool registry, optional speech-to-text, and the same supervisor/sub-agent infrastructure as the autonomous engine. Plan it as a first-class surface, not an afterthought.

### 3.14 Credits economy & onboarding

A credits balance with a usage bar is persistent in the footer. Actions debit credits (enrichment, full campaign, autonomous replies, website-visitor identification); onboarding quests credit them. The gamified 14-quest onboarding doubles as activation and as a guided setup path.

**Build:** a `credit_ledger` with metering middleware on every billable action, low-balance warnings, and top-up/upgrade. Model "AI/data work in credits, sending infrastructure in dollars." Replicate the quest system as an activation loop.

---

## 4. System Architecture

Five layers. Build the top two; rent the bottom three. This removes the two things a small team cannot build quickly (a contact database and deliverability infrastructure) and concentrates effort on the agent and the app.

| Layer | Responsibility | Build / Rent |
|---|---|---|
| Application / UI | All 12 modules + the copilot, onboarding, billing | **BUILD** |
| Agent orchestration | Supervisor + sub-agents: research, positioning, writing, reply handling, scheduling, copilot | **BUILD** |
| Data layer | Contact/company/local database, enrichment, intent signals, verification, de-anon | Rent (API) |
| Delivery layer | Email sending, inbox rotation, warmup, deliverability monitoring | Rent (API) |
| Intelligence layer | LLMs for research, writing, classification, the copilot | Rent (API) |

**Data flow (one lead):** onboarding builds the customer KB → Find leads / Signals / Website visitors source contacts → each is verified + enriched → Researcher assembles grounded facts → Positioning picks the angle → Writer drafts copy → draft enters Tasks (approve) or auto-sends once trusted → delivery layer sends + rotates inboxes → inbound replies are classified → Reply handler responds, books a meeting, or escalates to the Inbox.

### Agent design: supervisor + specialized sub-agents

| Sub-agent | Job | Model tier |
|---|---|---|
| Researcher | Structures verified facts from enrichment, KB, scraped pages | Cheap – mid |
| Positioning | Picks the angle: pain point, proof, CTA for this lead | Mid |
| Writer | Drafts the email in the customer's tone, grounded only in facts | Strong (best model) |
| Reply handler | Classifies inbound, drafts replies, books meetings, or escalates | Cheap (classify) + mid (draft) |
| Copilot | Conversational actions: ICP suggestions, analytics Q&A, deliverability checks, commands | Mid (+ cheap for routing) |

### Three safeguards, built in from day one

- **Idempotency.** Every job carries an idempotency key; a retried enrichment or send must never double-charge a provider or double-email a prospect.
- **Confidence-gated personalization.** If the Researcher lacks enough verified facts, the Writer falls back to a safe, lightly-personalized template instead of inventing details — controlling hallucination, which burns sender reputation.
- **Human-in-the-loop.** The reply agent acts autonomously only on a narrow allowlist (e.g. booking a clearly-requested meeting). Pricing promises, complaints, opt-outs, and negotiation escalate to the Inbox. Outbound can require approval in Tasks until autopilot is enabled.

---

## 5. Technology Stack (locked) & Repo Structure

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js (App Router) + TypeScript + Tailwind + shadcn/ui | One language; fast UI; strong AI-assisted coding |
| Frontend hosting | Vercel | First-class Next.js |
| Backend / API | Fastify 5 (TypeScript, ESM) + Node service on Railway | TS throughout; long-running work on Railway |
| Background jobs | Inngest (or Trigger.dev) | Durable, retryable, scheduled — the product is asynchronous; most important infra choice |
| Database + Auth | Supabase (Postgres + Auth + Row-Level Security) | DB, auth, tenant isolation in one |
| Vector store | pgvector inside Supabase | No separate vector service at this scale |
| Agent framework | LangGraph (TypeScript) | Supervisor + sub-agent pattern; durable state; tracing |
| LLM providers | Multi-model routing via an abstraction layer (Part 6) | Cheapest capable model per task, with failover |
| Web scraping | Firecrawl (or Playwright) | Clean text from sites for grounding |
| Contact data | Apollo API + a fallback (PDL / Enrich.so) | Rented discovery + enrichment, waterfalled |
| Email sending | Smartlead API (or Instantly) | Rented sending, inbox rotation, warmup |
| Verification | MillionVerifier (bulk) + ZeroBounce (catch-all) | Clean every list before send |
| Signals / intent | Crunchbase/Harmonic (funding) + hiring data + Bombora (topic) | Rented signal feeds |
| Web de-anon | Person-level identity API (RB2B-style) + own reverse-IP | Website-visitor module |
| Scheduling | Cal.com | Open-source meeting booking with an API |
| Telephony (later) | Twilio Voice + browser softphone | Dialer seats |
| Charts / icons | Recharts + Lucide | Clean analytics; consistent icons |

### Repo structure (separate frontend / backend)

```
repo: velora_frontend       -> Vercel
  app/ (Next.js App Router), components/, lib/api-client (typed),
  hooks/, types/ (generated from backend OpenAPI)

repo: velora_backend        -> Railway
  /api          (HTTP API: REST or tRPC)
  /workers      (Inngest: campaign executor, warmup monitor, inbox poller,
                 signal monitors, enrichment, de-anon ingest)
  /agents       (LangGraph: researcher, positioning, writer, reply-handler, copilot)
  /integrations (data, Smartlead, CRM, calendar, telephony, scraping, intent feeds)
  /db           (Supabase migrations & schema)
  openapi.json  (export -> frontend generates a typed client)
```

Keep types in sync by generating the frontend client from the backend's OpenAPI/tRPC schema.

---

## 6. Product LLM / API Strategy — chosen calculatively

The runtime cost center from Part 2, chosen per task. Principle: **only the final customer-facing email touches a strong model.** Everything else (research, extraction, classification, routing, copilot routing) runs on the cheapest capable tier. With routing + caching + batching, AI is the smallest variable cost.

**Verified current pricing (mid-2026)** — the cheap tier has dropped sharply in our favor. Per million tokens, input / output, standard rates:

| Model (current gen) | Price in/out | Use in our pipeline |
|---|---|---|
| Gemini 2.5 / 3.1 Flash-Lite | $0.10 / $0.40 | Cheapest: classification, routing, extraction, fact-gathering |
| DeepSeek V3.2 | $0.14 / $0.28 | Ultra-cheap alt (OpenAI-compatible, 90% cache discount) |
| Claude Haiku 4.5 | $1.00 / $5.00 | Mid: positioning, reply drafting, KB synthesis, copilot |
| Gemini 3 Flash | $0.50 / $3.00 | Mid alternate |
| Claude Sonnet 4.6 | $3.00 / $15.00 | STRONG: the final outbound email only |
| GPT-5.4 | $2.50 / $15.00 | Strong alternate / failover for the final email |

> Re-verify model lineup and prices each quarter — they move monthly.

### Per-task routing

| Task | Tier → model | Cost note |
|---|---|---|
| Onboarding / KB synthesis | Mid — Haiku 4.5 | One-time per customer; batchable |
| Researcher (gather facts) | Cheap — Flash-Lite / DeepSeek | High volume; cache the KB |
| Positioning (pick angle) | Mid — Haiku 4.5 | Short reasoning step |
| Writer (final email) | Strong — Sonnet 4.6 (GPT-5.4 failover) | Cap output ~150–200 tokens; cache KB |
| Reply classifier | Cheapest — Flash-Lite / DeepSeek | Tiny prompt, tiny output |
| Reply drafter | Mid — Haiku 4.5 | Only on the autonomy allowlist |
| Copilot (chat) | Mid — Haiku 4.5 (cheap router for tool selection) | Interactive; cache KB + context |
| Embeddings (RAG) | Embedding model (small) | Fractions of a cent |

### Cost-control mechanics (each a margin lever)

- **Model routing** — cheap models for the ~90% of simple calls; strong only for the final email. Cuts mixed AI cost ~60–90%.
- **Prompt caching** — the per-customer KB cached, billed ~10% of normal input per lead.
- **Batch processing** — non-real-time steps via batch APIs at ~50% off.
- **Cap output length** — output costs 3–5× input; a cold email is ~150–200 tokens.
- **Filter before spending** — verify + qualify cheaply first; spend full enrichment + the strong model only on survivors. The single biggest lever.

**Result:** ~$0.016 per fully-processed lead, ~$0.014 per reply — vs $0.05–$0.15 naive. At 10K leads/mo, ~$160 AI, the smallest line in the product.

### Provider redundancy

- **Abstraction layer** (Vercel AI SDK / LiteLLM / OpenRouter) so per-task choice and failover need no code churn.
- **Failover per tier** (e.g. Sonnet 4.6 → GPT-5.4 for the writer) to survive rate limits/outages; DeepSeek's OpenAI-compatibility is cheap insurance at the bottom.
- **Re-evaluate quarterly** — prices fell ~80% in a year and lineups shift monthly.

---

## 7. Core Data Model

Multi-tenant Postgres (Supabase), Row-Level Security from the first migration. Expanded with the entities the dashboard revealed (senders, signal subscriptions, website-visitor domains, lists, knowledge/coaching/proof, copilot threads).

| Group | Tables |
|---|---|
| Tenancy & access | `organizations`, `users`, roles/permissions, `integrations` (CRM/calendar OAuth + sync state) |
| Senders & sending | `senders` (per-member), `mailboxes` (primary/secondary, provider, warmup_state, daily_cap, reputation), `domains` (SPF/DKIM/DMARC), `linkedin_accounts`, `calendar_accounts`, `dialer_seats` |
| Knowledge & policy | `kb_documents`, `kb_chunks` (pgvector), `icp_profiles`, `coaching_points` (global + per-campaign), `proof_items` (highlight/customer/case_study), `guardrails` (autonomy rules), `default_settings` |
| Leads & data | `people`, `companies`, `local_businesses`, `lists`, `list_members`, `enrichment_cache` (provider + TTL) |
| Campaigns | `campaigns` (type enum), `campaign_steps` (sequence), `campaign_variants` (A/Z stats), `enrollments` (lead↔campaign STATE MACHINE) |
| Messaging | `threads`, `messages` (direction, channel, status, opens/clicks) |
| Signals | `signal_definitions` (catalog + live/coming-soon), `signal_subscriptions`, `signal_events` |
| Website visitors | `tracked_domains`, `visitor_identifications` (person/company, window) |
| Tasks & copilot | `tasks` (outbound_approval / manual / platform), `copilot_threads`, `copilot_messages` |
| Meetings | `meetings` (lead, sender, time, status) |
| Money & compliance | `credit_ledger` (every debit/credit), `suppression_list` (unsubscribe/bounce/complaint — GLOBAL + per-tenant) |

> **Build these in Phase 0:** `credit_ledger` (metering) and `suppression_list` (compliance + deliverability) — both painful to retrofit. The `senders` table is the hub the sending layer and campaigns both depend on.

---

## 8. Phased Delivery Plan (every module mapped)

One developer with AI-assisted coding. Some calendar time is fixed regardless of coding speed — chiefly email warmup (weeks). "Demo-ready" and "ready for paying customers" are different milestones; the gap is warmup, reply reliability, and compliance, not coding speed. **Buy domains and start warmup in parallel with Phase 0/1 — it is the longest pole.**

| Phase | Modules / what ships | Milestone |
|---|---|---|
| **0 — Foundations** | App shell + nav, Supabase auth, multi-tenant schema + RLS, Inngest (retry + idempotency), `credit_ledger`, `suppression_list`, LLM abstraction layer | Safe, isolated, async-ready base |
| **1 — Core, KB & discovery** | Onboarding quests, Manage-agent (Overview + Knowledge: coaching + proof), KB (scrape→chunk→pgvector), Find leads (NL + filters + AI suggestions), Leads (People/Companies/Local), Lists, Researcher + Writer agents (confidence-gated), Tasks (Outbound to approve), Chat copilot (basic) | Demo: onboard → find leads → grounded personalized drafts in the approval queue. Looks like the real product |
| **2 — Senders & sending** | Team/senders, mailbox OAuth (Google/Microsoft) + buy secondary mailboxes, Smartlead integration + warmup, Campaigns (full builder) for Cold outbound, verification on every lead, Analytics (Overview/Messaging/Deliverability basic) | Real emails from warmed inboxes; first pilot (warmup = calendar lead time) |
| **3 — Replies & autonomy** | Inbox (threaded; Needs action/No action/Sent), Reply-handler agent, Autonomous replies config, Guardrails, meeting booking (Cal.com), suppression + opt-out across domains, escalation | Loop closes end to end; books a meeting with no human touch on the happy path |
| **4 — Depth & launch** | Signals catalog (live four first), Website visitors (de-anon), remaining campaign types (Warm / Cross-sell / Website-visitor / Intent), A/Z self-optimization, CRM sync (HubSpot→Salesforce), Analytics (Credits/Dialer tabs + breakdowns + export), Dialer (seat-gated), Chat copilot (full agentic + commands + voice), autopilot, billing/metering, public self-serve site, compliance hardening | Approaches feature parity; ready for paid self-serve |

---

## 9. The Hard Problems & Realistic Ceiling

### Group A — replicable (~85–90%)

The full app surface: all 12 modules, the copilot, onboarding, the agent workflow (research/write/reply), campaigns + A/Z + analytics, meeting booking, CRM sync, signals, website visitors. In a demo it looks and behaves like the original.

### Group B — not matchable at launch (time-based)

| Constraint | Why it can't be shortcut | Position vs. competitor |
|---|---|---|
| Email deliverability | Reputation is earned per domain over weeks–months; no budget ages a domain faster | Worse for the first months; improves |
| Data accuracy | Rented data inherits provider ceilings (15–35% bounce; ~55% phone accuracy) | Approximate; thinner margins |
| Personalization / reply rates | Their prompts are tuned on years of real reply outcomes; we start empty | Same mechanism, lower reply rate until data accrues |
| Self-learning loop | Optimization compounds on aggregate data a new product lacks | Machinery present, starts empty |
| Reply edge cases | The hard middle is tuned over thousands of conversations | Handles easy replies; weaker on hard ones |
| Trust scaffolding | SOC 2 Type 2 needs a 6–12 month window; case studies need real results | Months-to-years gap; limits enterprise |

**Net:** ship something that looks like the original in weeks and performs like a strong early-stage version (~60–75% at launch), closing the gap with time in market. The unmatched parts are time-based and constrain every new entrant equally.

---

## 10. Unit Economics & Pricing

### Variable cost per lead (fully processed)

| Component | Low | High |
|---|---|---|
| Contact data + enrichment | $0.010 | $0.050 |
| Email verification | $0.004 | $0.008 |
| AI (routed + batched) | $0.016 | $0.022 |
| Reply handling (amortized ~3% reply) | $0.000 | $0.001 |
| **Total per lead** | **~$0.030** | **~$0.081** |

### Monthly cost to serve, by volume

| Bucket | 2K leads | 10K leads | 50K leads |
|---|---|---|---|
| Contact data + enrichment | $20–$100 | $100–$500 | $500–$2,500 |
| Email verification | ~$8 | ~$40 | ~$200 |
| AI (routed + batched) | ~$33 | ~$160 | ~$815 |
| Sending platform (Smartlead) | $39 | $94 | $94–$174 |
| Inboxes + domains | $30–$80 | $120–$300 | $400–$900 |
| **Total / customer / month** | **~$130–$260** | **~$510–$1,090** | **~$2,000–$4,600** |

### Pricing to win

| Plan | Target | Price | Cost to serve | Margin |
|---|---|---|---|---|
| Starter | Solo / small, ~2K leads/mo | $249/mo | ~$130–$260 | ~30–50% |
| Growth | Active team, ~10K leads/mo | $699/mo | ~$510–$1,090 | ~20–50% |
| Scale | Heavy / multi-ICP, ~50K leads/mo | $1,999/mo | ~$2,000–$4,600 | metered |

**Strategy:** price well under the incumbent (~$1,500–$2,000) while protecting margin by metering leads, starting customers email-only, and improving margin as domain reputation matures and volume rates are negotiated. Starter is the wedge. Mirror the credits model so heavy users pay for what they consume — AI/data work in credits, sending infrastructure in dollars.

> **Margin caveat:** renting the data + email moats keeps cost per customer structurally higher than the incumbent's at equal volume. Win on price and speed now; owning more of the stack is a scale-stage decision.

---

## 11. UI/UX & Design System

Match or exceed the category's design quality with our own identity — not a copy of their skin. Learn from what they do well; beat them on speed, clarity, transparency, and proof.

### Information architecture (mirror the proven structure)

The four-group sidebar (Manage / Engage / Lead discovery / Lead management) is a clean, learnable IA — adopt the same grouping. Two distinct oversight surfaces (Tasks for outbound approvals, Inbox for replies). A persistent agentic copilot. A gamified onboarding that doubles as setup. A persistent credits indicator.

### Principles that convert (2026)

- **Clarity in <5s:** one message → one primary CTA → one next step.
- **Proof above the fold:** real UI, real metrics, real logos beat copy.
- **Real product visuals + human warmth; motion that explains, not entertains; 3–5 features deep, not a 20-feature grid.**
- **Performance is a feature:** LCP < 2.5s, interaction < 200ms; mobile-first hero; one consistent design system.
- **Great empty states** — every empty state teaches the next action (e.g. "Add your first domain", friendly inbox-zero copy).

### Identity: neutral base + ONE ownable accent (not purple)

| Role | Value | Usage |
|---|---|---|
| Primary accent | Deep electric indigo `#4F46E5` (or teal `#0EA5A4`) | CTAs, links, active states, brand gradient — pick ONE |
| Accent gradient | Accent → near neighbor | Hero fading to near-white; subtle |
| Ink / Body grey | `#16181D` / `#4B5563` | Headlines+body / secondary |
| Surface / Border | `#FAFAFB`, `#FFFFFF` / `#E5E7EB` | Backgrounds / dividers |
| Success / Warning | `#10B981` / `#F59E0B` | Positive metrics / action flags |

**Type:** serif display (Instrument Serif / Fraunces) + sans body (Inter / Geist), variable fonts, two families max, tabular numerals, self-hosted. Consider a dark-first app surface (glows not shadows; WCAG AA 4.5:1).

**Motion:** Framer Motion + CSS; Lottie for a hero micro-demo; scroll reveals 150–300ms; respect prefers-reduced-motion; measure LCP/INP.

**App components:** shadcn/ui, rounded-xl cards, hairline borders, Recharts, skeleton loaders, toasts, clear review-queue states; Tailwind design tokens shared by marketing + app.

### Where we beat them

- **Deliverability transparency** as a first-class surface (per-mailbox reputation, seed-test results, spam-rate dashboards).
- **Faster, lighter pages** (strict LCP/INP budgets) and a genuinely mobile-first experience.
- **Clearer pricing + onboarding** than credit-heavy incumbents.
- **A sharper copilot** — the conversational layer is a strong differentiator if it actually takes reliable actions.

---

## 12. Compliance & Trust

- **Legal basis:** cold email is legal in the US (CAN-SPAM) and EU (GDPR legitimate interest) when done right — accurate sender identity, physical address, functional one-click opt-out, opt-outs honored promptly across all domains.
- **Suppression everywhere:** unsubscribes, bounces, complaints write to a global + per-tenant suppression list enforced on every send.
- **Authentication is table stakes:** SPF + DKIM + DMARC on every domain (enforced by Gmail/Yahoo/Microsoft); keep spam-complaint rate under 0.3%.
- **Data handling:** region-aware processing, retention controls, audit logging, RLS isolation. Person-level website de-anon carries real GDPR/CCPA exposure — document lawful basis + disclosures.
- **SOC 2** Type 2 needs a 6–12 month window — start controls early; it gates enterprise.

---

## 13. Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| Emails land in spam | Product appears broken; zero replies | Rent Smartlead; weeks of warmup; verify every list; rotate inboxes; monitor + auto-throttle |
| AI invents lead details | Embarrassing outreach; burned reputation | Confidence gating; ground every claim in retrieved facts |
| Reply agent mishandles a prospect | Damaged relationships; legal exposure | Human-review first; tight autonomy allowlist; escalate to Inbox |
| Rented data inaccurate | Bounces + wasted spend | Verify before send; filter low-confidence leads; waterfall providers |
| Compliance miss | Legal exposure | Suppression lists, honored opt-outs, required identifiers, audit logs |
| Cross-customer data leak | Serious trust incident | Row-Level Security from the first migration |
| Cost overrun on data/AI | Thin / negative margins | Filter before spending; routing; caching/batching; usage caps |
| Copilot takes a wrong action | Misconfigured campaigns, wasted credits | Confirmation on destructive/spending commands; scoped tool permissions |

---

## 14. Decisions Locked / Open & Immediate Next Steps

### Locked

- Own brand & identity; replicate workflow, not name/logo/copy/skin. Accent = indigo (or teal), not purple.
- Mirror the four-group IA, the Tasks-vs-Inbox split, the sender model, the knowledge/coaching/proof layer, the credits economy, and the agentic copilot.
- v1 = email-first; rented data + sending; human approval (Tasks) + escalation (Inbox) before autopilot. Defer LinkedIn automation, voice/dialer, and full autonomy to Phase 4+.
- Stack: Next.js + TS + shadcn/ui (Vercel) · Fastify + Inngest (Railway) · Supabase (Postgres+Auth+RLS+pgvector) · LangGraph TS · Smartlead · Apollo + fallback · MillionVerifier · Cal.com.
- Agent = supervisor + sub-agents (researcher / positioning / writer / reply-handler / copilot) with idempotency, confidence gating, human-in-the-loop.
- Product API routed: Flash-Lite/DeepSeek (cheap) → Haiku 4.5 (mid) → Sonnet 4.6 (final email, GPT-5.4 failover), with caching + batching.

### Open

- Brand accent: indigo vs teal (pin to final identity).
- Fallback data provider: People Data Labs vs Enrich.so vs both (by lead value).
- Smartlead vs Instantly; Inngest vs Trigger.dev; dark-first vs light-first app.
- Person-level de-anon vendor + region policy (defer to Phase 4 but choose vendor early).

### Immediate next steps

1. **Phase 0:** repos, Supabase + RLS schema (incl. `senders`, `credit_ledger`, `suppression_list`), Inngest + idempotency, LLM abstraction layer, app shell with the four-group nav, FE→Vercel / BE→Railway.
2. **Phase 1 agent core:** onboarding → KB (scrape/chunk/pgvector) + coaching/proof, Find leads (NL + filters + AI suggestions), Researcher + Writer (confidence-gated), Tasks approval queue, basic chat copilot. Target the "looks-real" demo.
3. **In parallel:** buy 2–3 sending domains + mailboxes and START WARMUP immediately — the longest pole.
4. **Lock brand accent + type;** build the marketing hero (proof above the fold, micro-demo, one CTA) and the instructive empty states.
5. **Wire the product-API routing layer** (provider-agnostic) with the Part 6 table and failover from day one.

---

_Bottom line: a credible end-to-end AI BDR can be shipped in weeks for ~$500–$1,100/month to serve a typical customer (Claude Max coding subscription excluded). It will look like the category leader immediately and perform like a strong early-stage version of it — closing the gap as domains age and outcome data accumulates, while we win now on price, speed, transparency, and a sharper copilot._