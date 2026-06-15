import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { EmailVerifier, Verdict, VerificationResult } from './types.js';

const ENDPOINT = 'https://api.millionverifier.com/api/v3/';

// 'ok' → deliverable; invalid/disposable → undeliverable (never send); everything else
// (catch_all/unknown/error/unexpected) → risky → proceed, flagged (catch-all is common for B2B;
// ZeroBounce catch-all refinement is a later add; 'error' is usually transient, not confirmed-bad).
export function verdictFromResult(result: string): Verdict {
  switch (result) {
    case 'ok':
      return 'deliverable';
    case 'invalid':
    case 'disposable':
      return 'undeliverable';
    default:
      return 'risky';
  }
}

/** Pure: parse a MillionVerifier v3 response body into our VerificationResult. */
export function parseVerifyResponse(body: unknown): VerificationResult {
  const b = (body ?? {}) as { result?: unknown; resultcode?: unknown };
  const result = typeof b.result === 'string' ? b.result : 'unknown';
  return {
    result,
    resultcode: typeof b.resultcode === 'number' ? b.resultcode : undefined,
    verdict: verdictFromResult(result),
  };
}

// Read-only verifier (mirrors the smartlead/scraper adapters). Returns null when unconfigured so
// sandbox/dev without a key proceeds with verification skipped; the real check engages with a key.
export function createMillionVerifier(): EmailVerifier | null {
  if (!env.MILLIONVERIFIER_API_KEY) return null;
  const apiKey = env.MILLIONVERIFIER_API_KEY;
  return {
    async verify(email: string): Promise<VerificationResult> {
      const url = new URL(ENDPOINT);
      url.searchParams.set('api', apiKey);
      url.searchParams.set('email', email);
      url.searchParams.set('timeout', '20');
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        throw new AppError(`MillionVerifier request failed (${res.status})`, {
          code: 'verifier_error',
          statusCode: 502,
        });
      }
      return parseVerifyResponse(await res.json());
    },
  };
}
