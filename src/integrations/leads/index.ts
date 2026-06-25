import { env } from '../../config/env.js';
import { createApolloProvider } from './apollo.js';
import { createSeedProvider } from './seed.js';
import type { LeadProvider } from './types.js';

/**
 * Pure provider selector (unit-testable without env). A REAL paid provider is returned ONLY when
 * LEAD_PROVIDER names it AND its key is present; every other case falls back to the seed fixture —
 * honest-off, no crash, ZERO spend. So forgetting the key can never silently start charging; it just
 * keeps serving the (free, deterministic) seed data.
 */
export function selectLeadProvider(provider: string, keys: { apollo?: string }): LeadProvider {
  if (provider === 'apollo' && keys.apollo) return createApolloProvider(keys.apollo);
  // 'seed' (default) — or a real provider selected without its key → safe seed fallback.
  return createSeedProvider();
}

/** Selects the lead-data provider from env. Apollo/PDL are drop-ins behind the LeadProvider contract. */
export function createLeadProvider(): LeadProvider {
  return selectLeadProvider(env.LEAD_PROVIDER, { apollo: env.APOLLO_API_KEY });
}
