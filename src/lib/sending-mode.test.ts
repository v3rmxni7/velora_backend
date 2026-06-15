import { describe, expect, it } from 'vitest';
import { AppError } from './errors.js';
import { assertLiveSendAllowed } from './sending-mode.js';

describe('assertLiveSendAllowed (the central send gate — safe by default)', () => {
  it('throws at the safe default (disabled + dry-run on)', () => {
    expect(() => assertLiveSendAllowed({ sendingEnabled: false, dryRun: true })).toThrow(AppError);
  });
  it('throws when enabled but still in dry-run', () => {
    expect(() => assertLiveSendAllowed({ sendingEnabled: true, dryRun: true })).toThrow();
  });
  it('throws when dry-run off but not enabled', () => {
    expect(() => assertLiveSendAllowed({ sendingEnabled: false, dryRun: false })).toThrow();
  });
  it('passes ONLY when explicitly enabled AND dry-run off (a deliberate live send)', () => {
    expect(() => assertLiveSendAllowed({ sendingEnabled: true, dryRun: false })).not.toThrow();
  });
});
