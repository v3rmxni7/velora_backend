// Smartlead read-only contract (Phase 2 Slice 2.1). Only the fields we consume are typed;
// the rest of each payload is preserved as-is into mailboxes.warmup_state / reputation.

export interface SmartleadWarmupDetails {
  status?: string; // e.g. 'ACTIVE'
  warmup_reputation?: string | number;
  total_sent_count?: number;
  total_spam_count?: number;
  [k: string]: unknown;
}

export interface SmartleadEmailAccount {
  id: number | string;
  from_email: string;
  from_name?: string;
  type?: string; // 'GMAIL' | 'OUTLOOK' | 'SMTP' | ...
  max_email_per_day?: number;
  warmup_details?: SmartleadWarmupDetails | null;
  [k: string]: unknown;
}

// Permissive — Smartlead returns last-7-day sent / inbox-placement / spam-placement counts;
// exact shape is finalized against the live API at the Slice-2.5 smoke.
export interface SmartleadWarmupStats {
  sent_count?: number;
  inbox_count?: number;
  spam_count?: number;
  [k: string]: unknown;
}

export interface SmartleadClient {
  listEmailAccounts(): Promise<SmartleadEmailAccount[]>;
  getWarmupStats(emailAccountId: string | number): Promise<SmartleadWarmupStats>;
}
