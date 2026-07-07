import { describe, expect, it } from 'vitest';
import { buildUnsubscribeUrl, signUnsubscribe, verifyUnsubscribe } from './unsubscribe.js';

const SECRET = 'test-unsubscribe-secret';
const ORG = '10ae80bf-0432-440b-bac9-a43f549feec2';

describe('unsubscribe token', () => {
  it('round-trips org + (lower-cased) email through sign → verify', () => {
    const token = signUnsubscribe(ORG, 'Ravi@Axieva.com', SECRET);
    const payload = verifyUnsubscribe(token, SECRET);
    expect(payload).toEqual({ organizationId: ORG, email: 'ravi@axieva.com' });
  });

  it('rejects a tampered body', () => {
    const token = signUnsubscribe(ORG, 'a@b.com', SECRET);
    const [, sig] = token.split('~');
    const forgedBody = Buffer.from(
      JSON.stringify({ organizationId: ORG, email: 'attacker@evil.com' }),
    ).toString('base64url');
    expect(verifyUnsubscribe(`${forgedBody}~${sig}`, SECRET)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = signUnsubscribe(ORG, 'a@b.com', SECRET);
    const [body] = token.split('~');
    expect(verifyUnsubscribe(`${body}~deadbeef`, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signUnsubscribe(ORG, 'a@b.com', SECRET);
    expect(verifyUnsubscribe(token, 'other-secret')).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyUnsubscribe('', SECRET)).toBeNull();
    expect(verifyUnsubscribe('noseparator', SECRET)).toBeNull();
    expect(verifyUnsubscribe('a~b~c', SECRET)).toBeNull();
    expect(verifyUnsubscribe('~', SECRET)).toBeNull();
    expect(verifyUnsubscribe('a.b', SECRET)).toBeNull(); // '.' is no longer the separator
  });

  it('builds an absolute /u?t=<token> URL and strips a trailing slash from the base', () => {
    const url = buildUnsubscribeUrl('https://api.example.com/', ORG, 'a@b.com', SECRET);
    expect(url.startsWith('https://api.example.com/u?t=')).toBe(true);
    const token = new URL(url).searchParams.get('t') ?? '';
    expect(verifyUnsubscribe(token, SECRET)).toEqual({ organizationId: ORG, email: 'a@b.com' });
  });
});
