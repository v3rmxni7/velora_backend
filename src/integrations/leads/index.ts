import { createSeedProvider } from './seed.js';
import type { LeadProvider } from './types.js';

/**
 * Selects the lead-data provider. Slice 2: the seed fixture (zero spend, CI-safe).
 * The Apollo/PDL adapter is a drop-in here later, selected by env once wired.
 */
export function createLeadProvider(): LeadProvider {
  return createSeedProvider();
}
