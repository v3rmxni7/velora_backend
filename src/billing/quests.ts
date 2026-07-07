// 4.10 — the 14-quest onboarding/activation engine (SPEC §3.1/§3.14).
//
// Quests pay REAL credits. Two honesty invariants make this trustworthy:
//  1. Completion is DERIVED from real org state (gatherQuestState reads the actual tables under RLS) —
//     never client-claimed. You cannot "mark" a quest done; you complete it by really doing the thing.
//  2. The AWARD is one idempotent credit_ledger row (reason='quest_reward',
//     idempotency_key='quest:{org}:{key}'). The unique key + append-only ledger guarantee a quest pays
//     AT MOST once, ever — re-reconciling is a no-op. Awards are never clawed back (activation credits
//     are earned even if the user later undoes the action).
//
// reconcileQuests writes via the service-role client with an explicit organization_id, so one org's
// actions can never award another org. gatherQuestState uses the RLS-scoped caller client.

import type { SupabaseClient } from '@supabase/supabase-js';

export type QuestGroup = 'setup' | 'grounding' | 'activation';

export interface QuestDef {
  key: string;
  label: string;
  reward: number;
  group: QuestGroup;
  href: string;
}

// 14 quests: the SPEC's 5 named ones + 9 more, each mapped to state that already has a table. Rewards
// mirror the SPEC's scale (+200 standard; +1000 secondary mailboxes; +400 autopilot / connect-a-source).
export const QUEST_CATALOG: QuestDef[] = [
  {
    key: 'connect-primary-mailbox',
    label: 'Connect a primary mailbox',
    reward: 200,
    group: 'setup',
    href: '/senders',
  },
  {
    key: 'email-signature',
    label: 'Set up an email signature',
    reward: 200,
    group: 'setup',
    href: '/senders',
  },
  {
    key: 'add-sending-domain',
    label: 'Add a sending domain',
    reward: 200,
    group: 'setup',
    href: '/senders',
  },
  {
    key: 'secondary-mailboxes',
    label: 'Add secondary mailboxes',
    reward: 1000,
    group: 'setup',
    href: '/senders',
  },
  {
    key: 'add-coaching',
    label: 'Add agent coaching',
    reward: 200,
    group: 'grounding',
    href: '/manage',
  },
  {
    key: 'add-proof',
    label: 'Add proof & results',
    reward: 200,
    group: 'grounding',
    href: '/manage',
  },
  {
    key: 'add-knowledge-source',
    label: 'Add a knowledge source',
    reward: 200,
    group: 'grounding',
    href: '/manage',
  },
  { key: 'define-icp', label: 'Define your ICP', reward: 200, group: 'grounding', href: '/manage' },
  {
    key: 'save-leads',
    label: 'Save your first leads',
    reward: 200,
    group: 'activation',
    href: '/lead-discovery',
  },
  {
    key: 'create-a-list',
    label: 'Create a list',
    reward: 200,
    group: 'activation',
    href: '/lists',
  },
  {
    key: 'build-a-sequence',
    label: 'Build a campaign sequence',
    reward: 200,
    group: 'activation',
    href: '/campaigns',
  },
  {
    key: 'launch-signal-campaign',
    label: 'Launch a signal-based campaign',
    reward: 200,
    group: 'activation',
    href: '/signals',
  },
  {
    key: 'connect-a-source',
    label: 'Connect a lead source (CRM, signals, or pixel)',
    reward: 400,
    group: 'activation',
    href: '/connections',
  },
  {
    // Autopilot (autonomy) is enabled deliberately as a staff-reviewed graduation step, never a
    // self-serve toggle (the anti-abuse gate + the two-flag safety model). The label reflects that —
    // it must NOT imply a button exists to flip. Completion is still derived from real autonomy state.
    key: 'turn-on-autopilot',
    label: 'Graduate to autopilot',
    reward: 400,
    group: 'activation',
    href: '/manage',
  },
];

export const QUEST_TOTAL = QUEST_CATALOG.length; // 14

// Raw signals gathered from real state — the input to the PURE evaluator (so completion logic is
// unit-testable without a database).
export interface QuestState {
  primaryMailboxes: number;
  totalMailboxes: number;
  sendersWithSignature: number;
  domains: number;
  signalCampaigns: number;
  autopilot: boolean;
  coachingPoints: number;
  proofItems: number;
  kbDocuments: number;
  icpProfiles: number;
  people: number;
  lists: number;
  campaignSteps: number;
  connectedIntegrations: number;
  activeSignalSubs: number;
  trackedDomains: number;
}

/** PURE: map raw state → per-quest completion. */
export function evaluateQuests(s: QuestState): Record<string, boolean> {
  return {
    'connect-primary-mailbox': s.primaryMailboxes > 0,
    'email-signature': s.sendersWithSignature > 0,
    'add-sending-domain': s.domains > 0,
    'secondary-mailboxes': s.totalMailboxes >= 2,
    'add-coaching': s.coachingPoints > 0,
    'add-proof': s.proofItems > 0,
    'add-knowledge-source': s.kbDocuments > 0,
    'define-icp': s.icpProfiles > 0,
    'save-leads': s.people > 0,
    'create-a-list': s.lists > 0,
    'build-a-sequence': s.campaignSteps > 0,
    'launch-signal-campaign': s.signalCampaigns > 0,
    'connect-a-source':
      s.connectedIntegrations > 0 || s.activeSignalSubs > 0 || s.trackedDomains > 0,
    'turn-on-autopilot': s.autopilot,
  };
}

// A single equality filter (column = value). Keeps the count helper typed without threading the
// supabase filter-builder generics through every call site.
type EqFilter = { column: string; value: string | number | boolean };

async function countRows(db: SupabaseClient, table: string, filter?: EqFilter): Promise<number> {
  let q = db.from(table).select('id', { count: 'exact', head: true });
  if (filter) q = q.eq(filter.column, filter.value);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

/** Gather real completion signals for the caller's org (RLS-scoped db). */
export async function gatherQuestState(
  db: SupabaseClient,
  organizationId: string,
): Promise<QuestState> {
  const [
    totalMailboxes,
    primaryMailboxes,
    domains,
    signalCampaigns,
    coachingPoints,
    proofItems,
    kbDocuments,
    icpProfiles,
    people,
    lists,
    campaignSteps,
    connectedIntegrations,
    activeSignalSubs,
    trackedDomains,
  ] = await Promise.all([
    countRows(db, 'mailboxes'),
    countRows(db, 'mailboxes', { column: 'is_primary', value: true }),
    countRows(db, 'domains'),
    countRows(db, 'campaigns', { column: 'campaign_type', value: 'intent_signals' }),
    countRows(db, 'coaching_points'),
    countRows(db, 'proof_items'),
    countRows(db, 'kb_documents'),
    countRows(db, 'icp_profiles'),
    countRows(db, 'people'),
    countRows(db, 'lists'),
    countRows(db, 'campaign_steps'),
    countRows(db, 'integrations', { column: 'status', value: 'connected' }),
    countRows(db, 'signal_subscriptions', { column: 'active', value: true }),
    countRows(db, 'website_tracked_domains'),
  ]);

  // Signature: a sender with non-empty signature text. Org-scoped via RLS; counted in JS so an
  // all-whitespace value doesn't falsely complete the quest.
  const sig = await db.from('senders').select('signature');
  if (sig.error) throw sig.error;
  const sendersWithSignature = (sig.data ?? []).filter(
    (r) => typeof r.signature === 'string' && r.signature.trim().length > 0,
  ).length;

  // Autopilot: the org's autonomy flag (RLS scopes to the caller's org).
  const org = await db
    .from('organizations')
    .select('autonomy_enabled')
    .eq('id', organizationId)
    .maybeSingle();
  if (org.error) throw org.error;
  const autopilot = org.data?.autonomy_enabled === true;

  return {
    totalMailboxes,
    primaryMailboxes,
    sendersWithSignature,
    domains,
    signalCampaigns,
    autopilot,
    coachingPoints,
    proofItems,
    kbDocuments,
    icpProfiles,
    people,
    lists,
    campaignSteps,
    connectedIntegrations,
    activeSignalSubs,
    trackedDomains,
  };
}

export interface QuestProgressItem extends QuestDef {
  done: boolean;
  awarded: boolean;
}

export interface QuestProgress {
  quests: QuestProgressItem[];
  completed: number;
  total: number;
  creditsEarned: number;
}

/**
 * Evaluate completion from real state and award credits for any newly-complete quest exactly once.
 *  - `db` is the RLS-scoped caller client (reads org state + existing quest awards).
 *  - `admin` is the service-role client (writes the ledger; clients can't). If null (service key
 *    absent), awards are skipped — completion still reports honestly, credits just don't post.
 * The award's idempotency_key ('quest:{org}:{key}') + the unique index = at-most-once payout; a 23505
 * on insert means a concurrent reconcile already paid it (treated as awarded, never double-charged).
 */
export async function reconcileQuests(
  db: SupabaseClient,
  admin: SupabaseClient | null,
  organizationId: string,
): Promise<QuestProgress> {
  const state = await gatherQuestState(db, organizationId);
  const done = evaluateQuests(state);

  // Existing quest awards for this org (the ledger is the record of what's been paid).
  const ledger = await db.from('credit_ledger').select('reference').eq('reason', 'quest_reward');
  if (ledger.error) throw ledger.error;
  const awarded = new Set<string>();
  for (const row of ledger.data ?? []) {
    const ref = row.reference as { questKey?: string } | null;
    if (ref?.questKey) awarded.add(ref.questKey);
  }

  for (const quest of QUEST_CATALOG) {
    if (!done[quest.key] || awarded.has(quest.key) || !admin) continue;
    const ins = await admin.from('credit_ledger').insert({
      organization_id: organizationId,
      delta: quest.reward,
      reason: 'quest_reward',
      reference: { type: 'quest', questKey: quest.key },
      idempotency_key: `quest:${organizationId}:${quest.key}`,
    });
    if (ins.error && ins.error.code !== '23505') throw ins.error;
    awarded.add(quest.key); // 23505 = a concurrent reconcile already paid it; still "awarded".
  }

  const quests: QuestProgressItem[] = QUEST_CATALOG.map((q) => ({
    ...q,
    done: done[q.key] ?? false,
    awarded: awarded.has(q.key),
  }));
  return {
    quests,
    completed: quests.filter((q) => q.done).length,
    total: QUEST_TOTAL,
    creditsEarned: quests.filter((q) => q.awarded).reduce((sum, q) => sum + q.reward, 0),
  };
}
