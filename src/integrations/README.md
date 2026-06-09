# integrations/

Thin clients for rented external services. Empty in Phase 0; populated as each phase needs them:

- **Data / enrichment** — Apollo (primary), PDL / Enrich.so (fallback) — Phase 1+
- **Email sending** — Smartlead (inbox rotation, warmup) — Phase 2
- **Verification** — MillionVerifier (bulk), ZeroBounce (catch-all) — Phase 2
- **Signals** — Crunchbase / Harmonic, Bombora — Phase 4
- **Booking** — Cal.com — Phase 3
- **Scraping** — Firecrawl / Playwright — Phase 1

Each client reads its credentials from `src/config/env.ts` (never `process.env` directly).
