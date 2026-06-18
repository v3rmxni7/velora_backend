import { describe, expect, it } from 'vitest';
import { snippet, summarizeMessages } from './brief.js';

// Pure-function units for the call brief (4.9). The DB-touching assembleBrief is covered by the
// RUN_DB_IT dialer suite; here we pin the deterministic (no-LLM) formatting.

describe('snippet', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(snippet('  hello   world  ')).toBe('hello world');
    expect(snippet('x'.repeat(200), 10)).toBe(`${'x'.repeat(10)}…`);
  });
  it('handles null/empty', () => {
    expect(snippet(null)).toBe('');
    expect(snippet(undefined)).toBe('');
  });
});

describe('summarizeMessages', () => {
  it('maps the newest N messages to an honest summary (no LLM narrative)', () => {
    const rows = [
      {
        direction: 'inbound',
        channel: 'email',
        subject: 'Re: Hi',
        status: 'replied',
        category: 'interested',
        created_at: '2026-06-12T10:00:00.000Z',
        body: 'Sounds great, tell me more about pricing.',
      },
      {
        direction: 'outbound',
        channel: 'email',
        subject: 'Hi',
        status: 'sent',
        category: null,
        created_at: '2026-06-11T10:00:00.000Z',
        body: 'Quick intro…',
      },
    ];
    const out = summarizeMessages(rows, 5);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      direction: 'inbound',
      subject: 'Re: Hi',
      status: 'replied',
      category: 'interested',
      at: '2026-06-12T10:00:00.000Z',
      snippet: 'Sounds great, tell me more about pricing.',
    });
  });
  it('caps at the limit', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      direction: 'outbound',
      channel: 'email',
      subject: `m${i}`,
      status: 'sent',
      category: null,
      created_at: `2026-06-1${i}T10:00:00.000Z`,
      body: 'x',
    }));
    expect(summarizeMessages(rows, 5)).toHaveLength(5);
  });
});
