import { describe, expect, it } from 'vitest';
import { dedupeRowsByConflict } from './lists.js';

// N7: the member upsert's onConflict is (organization_id, provider, external_id). A batch with the
// same (provider, external_id) twice would trip Postgres 21000; dedupe collapses it first.
describe('dedupeRowsByConflict (N7)', () => {
  it('collapses rows sharing (provider, external_id), keeping the last', () => {
    const out = dedupeRowsByConflict([
      { provider: 'seed', external_id: 'a', name: 'first' },
      { provider: 'seed', external_id: 'b', name: 'other' },
      { provider: 'seed', external_id: 'a', name: 'last' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.external_id === 'a')?.name).toBe('last');
  });

  it('treats the same external_id under different providers as distinct', () => {
    expect(
      dedupeRowsByConflict([
        { provider: 'apollo', external_id: 'x' },
        { provider: 'pdl', external_id: 'x' },
      ]),
    ).toHaveLength(2);
  });

  it('passes an already-unique batch through unchanged', () => {
    expect(
      dedupeRowsByConflict([
        { provider: 'seed', external_id: '1' },
        { provider: 'seed', external_id: '2' },
      ]),
    ).toHaveLength(2);
  });
});
