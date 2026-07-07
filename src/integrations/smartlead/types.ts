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

// One lead pushed into a Smartlead campaign — the rendered draft rides in custom_fields,
// matched by the campaign template's {{velora_subject}}/{{velora_body}} variables.
export interface SmartleadLead {
  email: string;
  custom_fields: Record<string, string>;
}

// One in-thread reply (Phase 3 Slice 3.4). `inReplyToMessageId` is the inbound reply's Smartlead
// message id (stored on our inbound message). The exact payload is verified at go-live; the dry-run
// path never calls this.
export interface SmartleadReply {
  email: string;
  subject: string | null;
  body: string;
  inReplyToMessageId: string | null;
}

// Mailbox-connect input (S3). The `password` is a PASS-THROUGH to Smartlead's /email-accounts/save —
// it lives only in transit through this object; Velora NEVER persists, logs, or echoes it.
export interface SmartleadEmailAccountInput {
  fromName: string;
  fromEmail: string;
  userName: string; // SMTP/IMAP login (usually = fromEmail); Smartlead's `user_name` (with underscore)
  password: string; // SMTP/app password — pass-through only
  smtpHost: string;
  smtpPort: number;
  imapHost: string; // IMAP is REQUIRED by Smartlead (reply detection + warmup), not just SMTP
  imapPort: number;
  maxEmailPerDay?: number;
}

// Result of a create/upsert. smtpOk/imapOk come from is_smtp_success/is_imap_success — a connect can
// return HTTP 200 with these false (bad creds), so the caller must check them, not just the 200.
export interface SmartleadCreatedAccount {
  id: string;
  smtpOk: boolean;
  imapOk: boolean;
}

export interface SmartleadClient {
  // --- read (2.1) ---
  listEmailAccounts(): Promise<SmartleadEmailAccount[]>;
  getWarmupStats(emailAccountId: string | number): Promise<SmartleadWarmupStats>;
  // --- write (2.5) ---
  createCampaign(name: string): Promise<{ id: string }>;
  saveSequence(campaignId: string, subjectVar: string, bodyVar: string): Promise<void>;
  assignEmailAccounts(campaignId: string, emailAccountIds: (string | number)[]): Promise<void>;
  setSchedule(campaignId: string, maxLeadsPerDay: number): Promise<void>;
  setStatus(campaignId: string, status: 'START' | 'PAUSED'): Promise<void>;
  addLead(campaignId: string, lead: SmartleadLead): Promise<void>;
  // --- reply (3.4) — an in-thread response, NOT a new cold lead ---
  sendReply(campaignId: string, reply: SmartleadReply): Promise<void>;
}

// The provisioning surface (S3 mailbox connect) — only the real + sandbox factory clients implement
// it; base SmartleadClient (used by the send/read paths + test fakes) is unchanged. createEmailAccount
// takes the password PASS-THROUGH and returns only ids/flags (never the credential).
export interface SmartleadProvisioningClient extends SmartleadClient {
  createEmailAccount(input: SmartleadEmailAccountInput): Promise<SmartleadCreatedAccount>;
  enableWarmup(emailAccountId: string | number): Promise<void>;
}
