import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { SmartleadClient } from '../../integrations/smartlead/types.js';
import { ensureSmartleadCampaign } from './provision.js';

// Guards the sentinel-poisoning fix: (1) a leftover 'provisioning:' sentinel is never returned as a
// real id, and (2) a Smartlead failure RELEASES the claim (sets smartlead_campaign_id back to null)
// so a retry re-provisions instead of the sentinel poisoning the campaign forever.

interface Log {
  campaignUpdates: Record<string, unknown>[];
  mailboxFilters: [string, unknown][];
}

function stubDb(log: Log, opts: { claimWins?: boolean } = {}): SupabaseClient {
  const claimWins = opts.claimWins ?? true;
  return {
    from(table: string) {
      if (table === 'mailboxes') {
        // Thenable + chainable: eq/not return q so `.not(...).eq('sender_id', ...)` composes, and
        // `await mbQuery` resolves via then — matching the real PostgREST builder.
        const q: any = {
          select: () => q,
          eq: (col: string, val: unknown) => {
            log.mailboxFilters.push([col, val]);
            return q;
          },
          not: () => q,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: [{ smartlead_email_account_id: 'acc1' }], error: null }),
        };
        return q;
      }
      if (table === 'campaigns') {
        return {
          update: (patch: Record<string, unknown>) => {
            log.campaignUpdates.push(patch);
            const chain: any = {
              eq: () => chain,
              is: () => chain,
              select: () =>
                Promise.resolve({ data: claimWins ? [{ id: 'camp1' }] : [], error: null }),
              then: (r: any) => r({ error: null }), // bare update(...).eq().eq() resolves ok
            };
            return chain;
          },
          select: () => ({
            eq: () => ({ single: async () => ({ data: { smartlead_campaign_id: null }, error: null }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

function fakeClient(overrides: Partial<SmartleadClient> = {}): SmartleadClient {
  return {
    createCampaign: vi.fn(async () => ({ id: 'sl-real-123' })),
    saveSequence: vi.fn(async () => {}),
    assignEmailAccounts: vi.fn(async () => {}),
    setSchedule: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
    ...overrides,
  } as unknown as SmartleadClient;
}

const camp = { id: 'camp1', organization_id: 'org1', name: 'C' };

describe('ensureSmartleadCampaign — sentinel poisoning fixes', () => {
  it('does NOT short-circuit on a leftover provisioning sentinel — it re-provisions and returns the real id', async () => {
    const log: Log = { campaignUpdates: [], mailboxFilters: [] };
    const db = stubDb(log);
    const client = fakeClient();
    const id = await ensureSmartleadCampaign(
      db,
      { ...camp, smartlead_campaign_id: `provisioning:camp1:${Date.now() - 5_000_000}` },
      client,
    );
    expect(id).toBe('sl-real-123');
    expect(client.createCampaign).toHaveBeenCalledOnce();
  });

  it('short-circuits on a REAL id (no Smartlead call)', async () => {
    const log: Log = { campaignUpdates: [], mailboxFilters: [] };
    const client = fakeClient();
    const id = await ensureSmartleadCampaign(
      stubDb(log),
      { ...camp, smartlead_campaign_id: 'sl-existing-9' },
      client,
    );
    expect(id).toBe('sl-existing-9');
    expect(client.createCampaign).not.toHaveBeenCalled();
  });

  it('scopes mailbox selection to the campaign sender when assigned (only that sender sends)', async () => {
    const log: Log = { campaignUpdates: [], mailboxFilters: [] };
    await ensureSmartleadCampaign(
      stubDb(log),
      { ...camp, smartlead_campaign_id: null, sender_id: 'sender-1' },
      fakeClient(),
    );
    expect(log.mailboxFilters).toContainEqual(['sender_id', 'sender-1']);
    expect(log.mailboxFilters).toContainEqual(['status', 'warm']);
  });

  it('does NOT add a sender filter when the campaign has no sender', async () => {
    const log: Log = { campaignUpdates: [], mailboxFilters: [] };
    await ensureSmartleadCampaign(
      stubDb(log),
      { ...camp, smartlead_campaign_id: null, sender_id: null },
      fakeClient(),
    );
    expect(log.mailboxFilters.some(([col]) => col === 'sender_id')).toBe(false);
  });

  it('RELEASES the claim to null when a Smartlead call throws (no permanent poisoning)', async () => {
    const log: Log = { campaignUpdates: [], mailboxFilters: [] };
    const db = stubDb(log);
    const client = fakeClient({
      createCampaign: vi.fn(async () => {
        throw new Error('smartlead timeout');
      }),
    });
    await expect(
      ensureSmartleadCampaign(db, { ...camp, smartlead_campaign_id: null }, client),
    ).rejects.toThrow('smartlead timeout');
    // the claim wrote a sentinel, then the failure released it back to null
    expect(log.campaignUpdates.some((u) => typeof u.smartlead_campaign_id === 'string' && String(u.smartlead_campaign_id).startsWith('provisioning:'))).toBe(true);
    expect(log.campaignUpdates.some((u) => u.smartlead_campaign_id === null)).toBe(true);
  });
});
