import { describe, expect, it } from 'vitest';
import {
  mapAccountToMailboxRow,
  mapProvider,
  mapWarmupStatsToReputation,
  mapWarmupStatus,
} from './mailbox-sync.js';

describe('mapProvider', () => {
  it('maps Smartlead account types to our provider enum', () => {
    expect(mapProvider('GMAIL')).toBe('gmail');
    expect(mapProvider('OUTLOOK')).toBe('microsoft');
    expect(mapProvider('SMTP')).toBe('smtp');
    expect(mapProvider(undefined)).toBe('unknown');
    expect(mapProvider('something-else')).toBe('unknown');
  });
});

describe('mapWarmupStatus', () => {
  it('treats active/running/warm as warming, otherwise connected', () => {
    expect(mapWarmupStatus({ status: 'ACTIVE' })).toBe('warming');
    expect(mapWarmupStatus({ status: 'paused' })).toBe('connected');
    expect(mapWarmupStatus(null)).toBe('connected');
  });
});

describe('mapAccountToMailboxRow', () => {
  it('maps a Smartlead account into a mailbox upsert row', () => {
    const row = mapAccountToMailboxRow(
      {
        id: 901,
        from_email: 'nischay@get-helloagentic.com',
        type: 'GMAIL',
        max_email_per_day: 30,
        warmup_details: { status: 'ACTIVE', warmup_reputation: '100%' },
      },
      'org-1',
    );
    expect(row).toMatchObject({
      organization_id: 'org-1',
      smartlead_email_account_id: '901',
      email: 'nischay@get-helloagentic.com',
      provider: 'gmail',
      daily_cap: 30,
      status: 'warming',
    });
    expect(row.warmup_state).toMatchObject({ status: 'ACTIVE' });
  });
  it('handles a missing daily cap + warmup', () => {
    const row = mapAccountToMailboxRow({ id: '902', from_email: 'a@x.com' }, 'org-1');
    expect(row.daily_cap).toBeNull();
    expect(row.warmup_state).toBeNull();
    expect(row.status).toBe('connected');
  });
});

describe('mapWarmupStatsToReputation', () => {
  it('extracts best-effort totals and preserves the raw payload', () => {
    const rep = mapWarmupStatsToReputation({ sent_count: 50, inbox_count: 48, spam_count: 2 });
    expect(rep).toMatchObject({ sent: 50, inbox: 48, spam: 2 });
    expect(rep.raw).toMatchObject({ sent_count: 50 });
  });
  it('defaults missing counts to 0', () => {
    expect(mapWarmupStatsToReputation({})).toMatchObject({ sent: 0, inbox: 0, spam: 0 });
  });
});
