import 'dotenv/config';
import { z } from 'zod';

// The ONLY place process.env is read. Everything else imports `env` from here.
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default('0.0.0.0'),
    CORS_ORIGIN: z.string().default('*'),

    // Supabase — optional in Phase 0 so the app boots without a live DB.
    SUPABASE_URL: z.url().optional(),
    SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

    // Inngest
    INNGEST_EVENT_KEY: z.string().optional(),
    INNGEST_SIGNING_KEY: z.string().optional(),

    // LLM providers (BYOK — used from Phase 1).
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    // Reserved — the Google/Gemini provider is NOT yet registered (getRegistry wires only anthropic +
    // deepseek); a gemini candidate fails over to deepseek/haiku. Setting this has no effect today.
    GOOGLE_API_KEY: z.string().optional(),
    // Cheap tier (Slice 3b) — DeepSeek via the OpenAI-compatible API.
    DEEPSEEK_API_KEY: z.string().optional(),
    DEEPSEEK_BASE_URL: z.string().default('https://api.deepseek.com'),

    // Scraping (Firecrawl) — KB ingestion, Phase 1 Slice 1.
    FIRECRAWL_API_KEY: z.string().optional(),

    // Lead-data provider (lead-sourcing slice) — BYOK, the ONE real functional gap.
    // LEAD_PROVIDER selects the find-leads source: 'seed' (default — the deterministic in-memory
    // fixture, zero spend, CI-safe) or a REAL paid provider 'apollo'/'pdl'. A real provider is used
    // ONLY when its key is also present; otherwise the seam falls back to 'seed' (honest-off, no
    // crash). HARD spend guardrails apply to metered providers ONLY (the seed never spends):
    //   • per-org + global DAILY SEARCH QUOTA (mirrors the send governor; counts 'lead_search' rows)
    //   • credit ENFORCE before the paid call (insufficient credits → no call) + a 'lead_search' debit
    //     after a successful call (LEAD_SEARCH_COST; default 1 — also makes the quota countable).
    // 'apollo' is the README's primary provider (built). PDL is the documented fallback — same
    // drop-in LeadProvider shape; add createPdlProvider + a 'pdl' enum value when wired.
    LEAD_PROVIDER: z.enum(['seed', 'apollo']).default('seed'),
    APOLLO_API_KEY: z.string().optional(),
    LEAD_SEARCH_COST: z.coerce.number().int().nonnegative().default(1),
    LEAD_DAILY_CAP_PER_ORG: z.coerce.number().int().nonnegative().default(25),
    LEAD_DAILY_CAP_GLOBAL: z.coerce.number().int().nonnegative().default(100),

    // Lead ENRICHMENT (on-enroll email reveal via the provider's match endpoint — Apollo charges its
    // own export credit per revealed email). Same two-ceiling discipline as search: per-org + global
    // DAILY quota counted on credit_ledger reason='enrichment' rows, credit ENFORCE before the paid
    // call, debit (ENRICH_COST) only AFTER a usable email is obtained — a failed/no-match enrichment
    // costs nothing on our meter. Runaway spend is structurally impossible.
    ENRICH_COST: z.coerce.number().int().nonnegative().default(1),
    ENRICH_DAILY_CAP_PER_ORG: z.coerce.number().int().nonnegative().default(100),
    ENRICH_DAILY_CAP_GLOBAL: z.coerce.number().int().nonnegative().default(500),

    // Sending substrate (Smartlead) — Phase 2. Read-only in Slice 2.1 (mailboxes + warmup);
    // write + webhook in 2.5. WEBHOOK_SECRET authenticates inbound webhooks: Smartlead does not
    // sign deliveries, so this is the shared token matched (timing-safe) against the registered
    // URL's ?token= param / the payload's secret_key / a legacy HMAC header (RUNBOOK §7.3).
    SMARTLEAD_API_KEY: z.string().optional(),
    SMARTLEAD_API_URL: z.string().default('https://server.smartlead.ai/api/v1'),
    SMARTLEAD_WEBHOOK_SECRET: z.string().optional(),

    // Email verification (MillionVerifier) — Phase 2 Slice 2.4. Absent → verification skipped.
    MILLIONVERIFIER_API_KEY: z.string().optional(),

    // Compliance footer (L1) — every LIVE send carries a physical postal address (CAN-SPAM) + a
    // WORKING opt-out. The opt-out is a Velora-HOSTED signed link (primary mechanism, provable and
    // self-contained) served at PUBLIC_BASE_URL/u/:token and signed with UNSUBSCRIBE_SECRET. Both are
    // optional at BOOT (the server must stay up), but a LIVE send is BLOCKED (fail-closed) when either
    // is unset — an unset value means we cannot mint a working unsubscribe link, which would be a
    // CAN-SPAM/GDPR violation. Dry-run / demo are never affected (the guard is live-branch only).
    // PUBLIC_BASE_URL = this backend's public origin (e.g. https://artisan-backend-...up.railway.app),
    // where the /u unsubscribe route is served. MUST be set on Railway before flipping an org to live.
    PUBLIC_BASE_URL: z.string().optional(),
    UNSUBSCRIBE_SECRET: z.string().optional(),

    // DKIM selector (Slice 4.12) — DKIM verification needs a selector we don't generically know. Absent
    // → DKIM stays honestly 'unknown' (never a fabricated 'pass'); SPF + DMARC verify regardless.
    DKIM_SELECTOR: z.string().optional(),

    // Self-serve signup (Slice 4.13) — the welcome credit grant a new org receives on provisioning. A
    // real credit_ledger row (reason 'signup_grant'); set to 0 to disable. Credits also accrue via the
    // 14-quest onboarding (4.10).
    SIGNUP_GRANT_CREDITS: z.coerce.number().int().nonnegative().default(200),

    // Website-visitor de-anon resolver (Slice 4.6) — 🔌 EXTERNAL, NOT connected. Absent → getResolver()
    // returns null and the website-visitor-monitor sweep is a no-op (visits recorded, never resolved;
    // People/Companies tabs honestly empty). Person-level resolution additionally requires a per-org
    // consent flag (ships with the de-anon connection slice). NEVER resolves a human on key-presence alone.
    WEBSITE_VISITOR_RESOLVER_API_KEY: z.string().optional(),

    // CRM connect + sync (Slice 4.7) — 🔌 EXTERNAL, NOT configured. Absent → /integrations/crm/connect
    // returns 'not_configured' (no fake connection) and the crm-sync-monitor is a no-op. OAUTH_STATE_SECRET
    // signs the single-use OAuth CSRF state. Tokens (when a real CRM connects at go-live) live ONLY in the
    // service-role integration_secrets vault, never on a client-readable column.
    HUBSPOT_CLIENT_ID: z.string().optional(),
    HUBSPOT_CLIENT_SECRET: z.string().optional(),
    SALESFORCE_CLIENT_ID: z.string().optional(),
    SALESFORCE_CLIENT_SECRET: z.string().optional(),
    OAUTH_STATE_SECRET: z.string().optional(),

    // Send volume governor (Slice 2.9 / audit H4) — Velora-side daily ceilings enforced at the send
    // chokepoint, independent of Smartlead's per-campaign cap. Conservative pilot defaults.
    DAILY_SEND_CAP_PER_ORG: z.coerce.number().int().nonnegative().default(50),
    DAILY_SEND_CAP_GLOBAL: z.coerce.number().int().nonnegative().default(200),

    // Anomaly monitor (Slice 3.5) — the self-protection circuit-breaker's thresholds. A breach over a
    // recent window auto-pauses an org's autonomy. Deterministic; sane conservative defaults.
    ANOMALY_BOUNCE_RATE: z.coerce.number().min(0).max(1).default(0.05), // > 5% bounce rate breaches
    ANOMALY_MIN_SENDS: z.coerce.number().int().nonnegative().default(20), // min window sends to judge a rate
    ANOMALY_MAX_COMPLAINTS: z.coerce.number().int().nonnegative().default(0), // any complaint breaches
    ANOMALY_WINDOW_HOURS: z.coerce.number().int().positive().default(24), // sliding window for the cohort
  })
  // Fail LOUD at boot in PRODUCTION (Fix-slice A / F1). These vars are .optional() above so dev/test/
  // Phase-0 boot without them — but in production a missing one makes the server boot green yet be
  // non-functional (auth 503s, crons silently dead, OAuth redirects to the wrong host). Prod-gated:
  // dev/test/CI (NODE_ENV !== 'production') are completely unaffected. The error names exactly what's
  // missing via the existing safeParse → prettifyError → exit(1) path below.
  .superRefine((data, ctx) => {
    if (data.NODE_ENV !== 'production') return;
    const requiredInProd = [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'INNGEST_SIGNING_KEY',
      'INNGEST_EVENT_KEY',
    ] as const;
    for (const key of requiredInProd) {
      if (!data[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when NODE_ENV=production (the server would boot but be non-functional without it).`,
        });
      }
    }
    if (data.CORS_ORIGIN === '*') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGIN'],
        message:
          "CORS_ORIGIN must be set to your frontend origin(s) when NODE_ENV=production, not the '*' default (it also breaks the CRM OAuth callback redirect target).",
      });
    }
  });

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:\n');
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;
