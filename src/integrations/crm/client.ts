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

/** 🔌 deferred: exchange an authorization code for tokens. No real exchange ships in 4.7 (returns
 * null → the callback records status='error', never a fake token). Real exchange ships with the
 * provider client + a registered OAuth app. */
export async function exchangeOAuthCode(
  _env: Env,
  _provider: CrmProvider,
  _code: string,
  _redirectUri: string,
): Promise<{ oauth: Record<string, unknown> } | null> {
  return null;
}

/**
 * The honest-empty switch. Returns null unless the provider's creds AND a connected token exist — and
 * even then, this slice ships NO real provider client, so it returns null (the crm-sync-monitor is a
 * documented no-op). The real HubSpot/Salesforce clients ship with the connection slice.
 */
export function getCrmClient(env: Env, provider: string, oauth: unknown): CrmClient | null {
  if (!isCrmProvider(provider) || !getCrmOAuthCreds(env, provider)) return null; // not configured
  if (!oauth) return null; // not connected (no tokens)
  return null; // 🔌 no real provider client implemented in 4.7
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
