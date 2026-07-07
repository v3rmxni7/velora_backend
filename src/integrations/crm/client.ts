import type { Env } from '../../config/env.js';

// Phase 4 Slice 4.7 — the CRM client seam (🔌 EXTERNAL, NOT configured). Pulling contacts from
// HubSpot/Salesforce is the part you BUY (a registered OAuth app + the provider's API). No real
// provider client is implemented in this slice, so getCrmClient() returns null and the crm-sync-monitor
// is a documented no-op — nothing syncs, warm/cross_sell stay honestly source-not-connected. The
// sync pipeline is proven end-to-end only by a TEST-ONLY FakeCrmClient. Tokens are passed in from the
// service-role integration_secrets vault and never logged.

export type CrmProvider = 'hubspot' | 'salesforce';
export const CRM_PROVIDERS: CrmProvider[] = ['hubspot', 'salesforce'];
export function isCrmProvider(p: string): p is CrmProvider {
  return p === 'hubspot' || p === 'salesforce';
}

/** A PERSON contact from a CRM. email-less contacts (company/account records) are display-only. */
export interface CrmContact {
  externalId: string;
  email?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  companyName?: string | null;
}
export interface CrmContactPage {
  contacts: CrmContact[];
  cursor?: string;
}
export interface CrmClient {
  readonly provider: string;
  listContacts(cursor?: string): Promise<CrmContactPage>;
}

export interface CrmOAuthCreds {
  clientId: string;
  clientSecret: string;
}

/** The OAuth app creds for a provider, or null when unconfigured (the honest-shell switch). */
export function getCrmOAuthCreds(env: Env, provider: CrmProvider): CrmOAuthCreds | null {
  if (provider === 'hubspot' && env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET) {
    return { clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET };
  }
  if (provider === 'salesforce' && env.SALESFORCE_CLIENT_ID && env.SALESFORCE_CLIENT_SECRET) {
    return { clientId: env.SALESFORCE_CLIENT_ID, clientSecret: env.SALESFORCE_CLIENT_SECRET };
  }
  return null;
}

/** Which providers are configurable (creds present) — drives the FE connect affordance. Empty in the demo. */
export function configurableProviders(env: Env): CrmProvider[] {
  return CRM_PROVIDERS.filter((p) => getCrmOAuthCreds(env, p) !== null);
}

const AUTHORIZE_BASE: Record<CrmProvider, string> = {
  hubspot: 'https://app.hubspot.com/oauth/authorize',
  salesforce: 'https://login.salesforce.com/services/oauth2/authorize',
};
const SCOPES: Record<CrmProvider, string> = {
  hubspot: 'crm.objects.contacts.read',
  salesforce: 'api refresh_token',
};

/** The provider authorize URL (go-live). Only built when creds exist — dormant in the demo. */
export function buildAuthorizeUrl(
  provider: CrmProvider,
  creds: CrmOAuthCreds,
  redirectUri: string,
  state: string,
): string {
  const q = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES[provider],
    state,
  });
  return `${AUTHORIZE_BASE[provider]}?${q.toString()}`;
}

// ── HubSpot OAuth + Contacts (T1) ────────────────────────────────────────────────────────────────
// exchangeOAuthCode + getCrmClient are REAL for HubSpot (Salesforce still deferred). Tokens are
// SECRETS: they live only in the service-role integration_secrets.oauth vault and are NEVER logged,
// echoed in an error, or returned. The client is stateless in the hot path — it re-mints a short-lived
// access token from the stored refresh_token each run (we persist ONLY the refresh_token) — and
// STATEFUL-CAPABLE: if HubSpot returns a ROTATED refresh_token it persists the new one via the injected
// `persist` callback (HubSpot tokens are stable today, but rotation is not contractually guaranteed —
// this removes the only correctness risk). Exact wire contracts are HIGH-confidence from HubSpot's
// public guides but their api-reference is login-gated → `fetchImpl` is injectable so tests pin the
// contract and the first live connect confirms it. See memory t1-hubspot-crm-step0.

const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const HUBSPOT_CONTACTS_URL = 'https://api.hubapi.com/crm/v3/objects/contacts';
const HUBSPOT_CONTACT_PROPS = ['email', 'firstname', 'lastname', 'jobtitle', 'company'] as const;

type FetchLike = typeof fetch;

/** The token bundle stored in the vault — ONLY the refresh_token (the access token is short-lived and
 *  re-minted each sync run, so it is never written to the DB). */
export interface CrmTokenBundle {
  refresh_token?: string;
  token_type?: string;
}
interface HubspotTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
}
interface HubspotContactResult {
  id: string | number;
  properties?: Record<string, string | null | undefined>;
}
interface HubspotContactsResponse {
  results?: HubspotContactResult[];
  paging?: { next?: { after?: string } };
}

export interface CrmClientOpts {
  /** Persist a rotated token bundle to the vault. Fired ONLY when HubSpot returns a NEW refresh_token.
   *  Supplied by the sync monitor (which holds the integration id + the service-role db). */
  persist?: (oauth: CrmTokenBundle) => Promise<void>;
  /** Injectable fetch — tests pin the wire contract; prod uses global fetch. */
  fetchImpl?: FetchLike;
}

/** A CRM auth/transport failure carrying only a non-sensitive CODE — never a token or response body. */
export class CrmAuthError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'CrmAuthError';
  }
}

/** Pure: a HubSpot contact result → our CrmContact. */
export function mapHubspotContact(r: HubspotContactResult): CrmContact {
  const p = r.properties ?? {};
  const firstName = p.firstname?.trim() || null;
  const lastName = p.lastname?.trim() || null;
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || null;
  return {
    externalId: String(r.id),
    email: p.email?.trim() || null,
    fullName,
    firstName,
    lastName,
    title: p.jobtitle?.trim() || null,
    companyName: p.company?.trim() || null,
  };
}

export class HubspotCrmClient implements CrmClient {
  readonly provider = 'hubspot';
  private accessToken?: string;
  private refreshToken: string;
  private readonly doFetch: FetchLike;
  constructor(
    private readonly creds: CrmOAuthCreds,
    bundle: CrmTokenBundle,
    private readonly opts: CrmClientOpts = {},
  ) {
    this.refreshToken = bundle.refresh_token ?? '';
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /** Mint (once per client) a fresh access token from the stored refresh token; conditionally persists
   *  a rotated refresh token. Never logs/echoes the token or the response body. */
  private async accessTokenOnce(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    if (!this.refreshToken) throw new CrmAuthError('missing_refresh_token');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      refresh_token: this.refreshToken,
    });
    const res = await this.doFetch(HUBSPOT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }).catch(() => null);
    if (!res) throw new CrmAuthError('refresh_network_error');
    if (!res.ok) {
      // 400/403 → refresh token revoked/invalid (BAD_REFRESH_TOKEN): the tenant must reconnect.
      throw new CrmAuthError(
        res.status === 400 || res.status === 403 ? 'refresh_token_invalid' : 'refresh_failed',
      );
    }
    const json = (await res.json()) as HubspotTokenResponse;
    if (!json.access_token) throw new CrmAuthError('refresh_no_access_token');
    this.accessToken = json.access_token;
    // Conditional persist: HubSpot MAY return a rotated refresh token — keep the latest.
    if (
      typeof json.refresh_token === 'string' &&
      json.refresh_token &&
      json.refresh_token !== this.refreshToken
    ) {
      this.refreshToken = json.refresh_token;
      await this.opts.persist?.({
        refresh_token: json.refresh_token,
        token_type: json.token_type ?? 'bearer',
      });
    }
    return this.accessToken;
  }

  async listContacts(cursor?: string): Promise<CrmContactPage> {
    const token = await this.accessTokenOnce();
    const q = new URLSearchParams();
    for (const p of HUBSPOT_CONTACT_PROPS) q.append('properties', p);
    q.set('limit', '100');
    if (cursor) q.set('after', cursor);
    const res = await this.doFetch(`${HUBSPOT_CONTACTS_URL}?${q.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (!res) throw new CrmAuthError('contacts_network_error');
    if (!res.ok) throw new CrmAuthError(`contacts_http_${res.status}`);
    const json = (await res.json()) as HubspotContactsResponse;
    const contacts = (json.results ?? []).map(mapHubspotContact);
    return { contacts, cursor: json.paging?.next?.after };
  }
}

/** Testable core: exchange an authorization code for a HubSpot token bundle. Returns the vault bundle
 *  (refresh_token only) or null on ANY failure. NEVER echoes the code/secret/response body. */
export async function exchangeHubspotCode(
  creds: CrmOAuthCreds,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ oauth: Record<string, unknown> } | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetchImpl(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }).catch(() => null);
  if (!res || !res.ok) return null; // never read/echo the error body
  const json = (await res.json()) as HubspotTokenResponse;
  if (!json.refresh_token) return null;
  return { oauth: { refresh_token: json.refresh_token, token_type: json.token_type ?? 'bearer' } };
}

/** Exchange the callback code for tokens (env-reading wrapper; HubSpot only in T1). null → the callback
 *  records status='error', never a fake token. */
export async function exchangeOAuthCode(
  env: Env,
  provider: CrmProvider,
  code: string,
  redirectUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ oauth: Record<string, unknown> } | null> {
  const creds = getCrmOAuthCreds(env, provider);
  if (!creds || provider !== 'hubspot') return null; // only HubSpot exchange ships in T1
  return exchangeHubspotCode(creds, code, redirectUri, fetchImpl);
}

/**
 * The real provider-client factory. Honest-empty: null unless the provider's creds AND a stored refresh
 * token exist. Only HubSpot ships a client in T1 (Salesforce deferred → null even if creds present).
 */
export function getCrmClient(
  env: Env,
  provider: string,
  oauth: unknown,
  opts: CrmClientOpts = {},
): CrmClient | null {
  if (!isCrmProvider(provider) || !getCrmOAuthCreds(env, provider)) return null; // not configured
  const creds = getCrmOAuthCreds(env, provider);
  if (!creds || provider !== 'hubspot') return null; // Salesforce client deferred
  const bundle = oauth && typeof oauth === 'object' ? (oauth as CrmTokenBundle) : null;
  if (!bundle?.refresh_token) return null; // not connected (no token)
  return new HubspotCrmClient(creds, bundle, opts);
}

/**
 * TEST-ONLY fixture. Lets the integration suite prove the contact→lead→enrollment pipeline
 * deterministically. NEVER used in production (getCrmClient returns null there → the monitor is a real
 * no-op). A green suite means the seam is correct, NOT that a CRM is connected.
 */
export class FakeCrmClient implements CrmClient {
  readonly provider: string;
  constructor(
    private readonly contacts: CrmContact[],
    provider = 'fake',
  ) {
    this.provider = provider;
  }
  async listContacts(): Promise<CrmContactPage> {
    return { contacts: this.contacts };
  }
}
