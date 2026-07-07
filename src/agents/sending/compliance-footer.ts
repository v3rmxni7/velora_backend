import { buildUnsubscribeUrl } from '../../lib/unsubscribe.js';

// L1 compliance footer — appended to the body of EVERY live send (cold + reply). CAN-SPAM requires a
// valid physical postal address of the sender + a working opt-out; GDPR/PECR want an easy opt-out.
// PRESENTATION of the footer is here; the fail-closed decision (block a live send when the inputs are
// missing) is `resolveCompliantBody`, which is PURE so it is exhaustively unit-testable. The send
// chokepoints read org.postal_address + the env (PUBLIC_BASE_URL / UNSUBSCRIBE_SECRET) and call it
// INSIDE the live branch only — dry-run / demo never hit this, and it is an ADDITIONAL gate after the
// two-flag check, never a loosening.

/** Why a live send is not compliance-ready (fail-closed reasons). */
export type ComplianceBlockReason = 'compliance_address_unset' | 'compliance_unsub_unconfigured';

export interface ComplianceContext {
  postalAddress: string | null | undefined;
  /** PUBLIC_BASE_URL — the origin serving the /u unsubscribe route. */
  baseUrl: string | undefined;
  /** UNSUBSCRIBE_SECRET — signs the per-recipient unsubscribe token. */
  secret: string | undefined;
  organizationId: string;
  /** The exact recipient address the unsubscribe token binds to. */
  email: string;
}

/** The plain-text compliance footer, delivered verbatim (velora_body custom field / reply body). */
export function buildComplianceFooter(postalAddress: string, unsubscribeUrl: string): string {
  return ['', '—', postalAddress, `Don't want these emails? Unsubscribe: ${unsubscribeUrl}`].join(
    '\n',
  );
}

/** Append the footer to a body, normalizing trailing whitespace so there is one clean separator. */
export function appendComplianceFooter(body: string, footer: string): string {
  return `${body.replace(/\s+$/, '')}\n${footer}`;
}

/**
 * The fail-closed gate + composition, PURE. Returns the compliance-appended body when every input is
 * present, or a block reason otherwise. A live send MUST NOT proceed on a `{ ok: false }` result.
 * - no postal address  → 'compliance_address_unset' (CAN-SPAM address missing)
 * - no baseUrl/secret  → 'compliance_unsub_unconfigured' (cannot mint a working unsubscribe link)
 */
export function resolveCompliantBody(
  rawBody: string,
  ctx: ComplianceContext,
):
  | { ok: true; body: string; unsubscribeUrl: string }
  | { ok: false; reason: ComplianceBlockReason } {
  const address = ctx.postalAddress?.trim();
  if (!address) return { ok: false, reason: 'compliance_address_unset' };
  if (!ctx.baseUrl?.trim() || !ctx.secret?.trim()) {
    return { ok: false, reason: 'compliance_unsub_unconfigured' };
  }
  const unsubscribeUrl = buildUnsubscribeUrl(
    ctx.baseUrl,
    ctx.organizationId,
    ctx.email,
    ctx.secret,
  );
  const body = appendComplianceFooter(rawBody, buildComplianceFooter(address, unsubscribeUrl));
  return { ok: true, body, unsubscribeUrl };
}
