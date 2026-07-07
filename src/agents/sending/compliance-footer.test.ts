import { describe, expect, it } from 'vitest';
import { verifyUnsubscribe } from '../../lib/unsubscribe.js';
import { appendComplianceFooter, resolveCompliantBody } from './compliance-footer.js';

const ORG = '10ae80bf-0432-440b-bac9-a43f549feec2';
const OK = {
  postalAddress: 'HelloAgentic, 123 Example St, Bengaluru 560001, India',
  baseUrl: 'https://api.example.com',
  secret: 'unsub-secret',
  organizationId: ORG,
  email: 'ravi@axieva.com',
};

describe('resolveCompliantBody — fail-closed compliance gate (pure)', () => {
  it('BLOCKS when postal address is unset (null / empty / whitespace)', () => {
    for (const postalAddress of [null, undefined, '', '   ']) {
      const r = resolveCompliantBody('Hi Ravi — quick question.', { ...OK, postalAddress });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('compliance_address_unset');
    }
  });

  it('BLOCKS when the unsubscribe link cannot be minted (baseUrl or secret unset)', () => {
    const noBase = resolveCompliantBody('Hi', { ...OK, baseUrl: undefined });
    expect(noBase.ok).toBe(false);
    if (!noBase.ok) expect(noBase.reason).toBe('compliance_unsub_unconfigured');

    const noSecret = resolveCompliantBody('Hi', { ...OK, secret: '' });
    expect(noSecret.ok).toBe(false);
    if (!noSecret.ok) expect(noSecret.reason).toBe('compliance_unsub_unconfigured');
  });

  it('ALLOWS when address + baseUrl + secret are all set, and appends a compliant footer', () => {
    const raw = 'Hi Ravi — quick question on Axieva.';
    const r = resolveCompliantBody(raw, OK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Original body preserved.
    expect(r.body.startsWith(raw)).toBe(true);
    // Physical postal address present (CAN-SPAM).
    expect(r.body).toContain(OK.postalAddress);
    // A working, verifiable unsubscribe link (the primary opt-out) present.
    expect(r.body).toContain(r.unsubscribeUrl);
    expect(r.unsubscribeUrl).toContain('/u?t=');
    const token = new URL(r.unsubscribeUrl).searchParams.get('t') ?? '';
    expect(verifyUnsubscribe(token, OK.secret)).toEqual({
      organizationId: ORG,
      email: OK.email,
    });
  });

  it('appendComplianceFooter normalizes trailing whitespace to one clean separator', () => {
    expect(appendComplianceFooter('body\n\n  ', '\n—\nfooter')).toBe('body\n\n—\nfooter');
  });
});
