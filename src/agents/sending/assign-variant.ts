import { createHash } from 'node:crypto';

/**
 * Deterministic, even assignment of a key to one of `count` A/Z variants (Slice 4.4). PURE: the same
 * key always maps to the same index, so concurrent launches AND re-launches converge on the same
 * variant with NO counter and NO race (the even split is by construction — never outcome-weighted,
 * so it can never fabricate a "winner"). Uses the first 32 bits of sha256(key) mod count (the
 * kb/chunk.ts crypto pattern).
 *
 * `count <= 1` → 0. KEY must be the STABLE pre-insert identity `${campaignId}:${leadType}:${leadId}`
 * (lowercased uuids) — NOT the enrollment id, which does not exist until after insert.
 */
export function assignVariantIndex(key: string, count: number): number {
  if (count <= 1) return 0;
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return Number.parseInt(hex, 16) % count;
}
