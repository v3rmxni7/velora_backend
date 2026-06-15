// Email verification contract (Phase 2 Slice 2.4).
export type Verdict = 'deliverable' | 'risky' | 'undeliverable';

export interface VerificationResult {
  result: string; // raw provider result: ok | catch_all | unknown | error | disposable | invalid
  resultcode?: number;
  verdict: Verdict;
}

export interface EmailVerifier {
  verify(email: string): Promise<VerificationResult>;
}
