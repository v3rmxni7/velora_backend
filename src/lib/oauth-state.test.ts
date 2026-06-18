import { describe, expect, it } from 'vitest';
import { signState, verifyState } from './oauth-state.js';

const SECRET = 'test-oauth-state-secret';

describe('oauth-state', () => {
  it('round-trips a signed state (org + provider + nonce recovered)', () => {
    const { state, nonce } = signState('org-1', 'hubspot', SECRET);
    const payload = verifyState(state, SECRET);
    expect(payload).toMatchObject({ organizationId: 'org-1', provider: 'hubspot', nonce });
  });

  it('rejects a tampered body or signature', () => {
    const { state } = signState('org-1', 'hubspot', SECRET);
    const [body, sig] = state.split('.');
    expect(verifyState(`${body}x.${sig}`, SECRET)).toBeNull();
    expect(verifyState(`${body}.${sig}x`, SECRET)).toBeNull();
  });

  it('rejects a different secret (forged signature)', () => {
    const { state } = signState('org-1', 'hubspot', SECRET);
    expect(verifyState(state, 'other-secret')).toBeNull();
  });

  it('rejects an expired state', () => {
    const { state } = signState('org-1', 'hubspot', SECRET, -1_000); // already expired
    expect(verifyState(state, SECRET)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifyState('not-a-state', SECRET)).toBeNull();
    expect(verifyState('', SECRET)).toBeNull();
  });
});
