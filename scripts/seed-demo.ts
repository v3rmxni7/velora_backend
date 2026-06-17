import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import type { LeadType } from '../src/agents/draft/generate.js';
import { launchCampaign } from '../src/agents/sending/enroll.js';
import { refreshMailboxWarmup, syncMailboxes } from '../src/agents/sending/mailbox-sync.js';
import { type EnrollmentRecord, prepareEnrollment } from '../src/agents/sending/pipeline.js';
import { env } from '../src/config/env.js';
import { createSmartleadClient } from '../src/integrations/smartlead/smartlead.js';

/** Slug a company name into a reserved, non-deliverable .example domain (RFC 2606). */
function demoDomain(company: string): string {
  return `${company.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`;
}

// Demo-account seeder (service-role) — provisions the account the frontend logs in as:
// one org + one auth user + a small KB + ~5 leads. Idempotent: safe to re-run (no duplicate
// org/user/leads). Run: `pnpm seed:demo`. Never prints the service-role key.
//
// Idempotency design: lead with createUser so a re-run hits "already registered" → recover the
// id; the existing users-row link is then reused (no new org), KB is replaced, leads upsert by
// a stable external_id.

const EMAIL = process.env.DEMO_EMAIL ?? 'demo@velora.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Velora-Demo-2026!';

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function findAuthUserId(email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const u = data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    if (u) return u.id;
    if (data.users.length < 1000) break;
  }
  return null;
}

/** Create the auth user, or recover its id if already registered (resetting the password). */
async function ensureAuthUserId(
  email: string,
  password: string,
): Promise<{ id: string; created: boolean }> {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (!created.error && created.data.user) return { id: created.data.user.id, created: true };
  // Likely "already registered" → recover the id and reset the password so sign-in is deterministic.
  const id = await findAuthUserId(email);
  if (!id) throw created.error ?? new Error('could not create or find the demo auth user');
  const upd = await admin.auth.admin.updateUserById(id, { password });
  if (upd.error) throw upd.error;
  return { id, created: false };
}

async function main(): Promise<void> {
  const { id: userId, created } = await ensureAuthUserId(EMAIL, PASSWORD);

  // Reuse the existing org link if present; else create the org + link (no duplicate on re-run).
  const link = await admin.from('users').select('organization_id').eq('id', userId).maybeSingle();
  if (link.error) throw link.error;

  let orgId: string;
  if (link.data) {
    orgId = link.data.organization_id as string;
  } else {
    const org = await admin
      .from('organizations')
      .insert({ name: 'Velora Demo' })
      .select('id')
      .single();
    if (org.error) throw org.error;
    orgId = org.data.id as string;
    const ins = await admin
      .from('users')
      .insert({ id: userId, organization_id: orgId, email: EMAIL, role: 'owner' });
    if (ins.error) throw ins.error;
  }

  // Demo reset: clear the org's pipeline state so every re-run yields a clean, freshly-driven demo
  // (drafts regenerate live under the current gate). FK-safe order: messages → enrollments → tasks
  // → threads. All scoped to the demo org; nothing real is sent (this is dry-run-only demo data).
  await admin.from('messages').delete().eq('organization_id', orgId);
  await admin.from('enrollments').delete().eq('organization_id', orgId);
  await admin.from('tasks').delete().eq('organization_id', orgId);
  await admin.from('threads').delete().eq('organization_id', orgId);
  await admin
    .from('people')
    .delete()
    .eq('organization_id', orgId)
    .like('external_id', 'demo:sparse:%');

  // KB (idempotent): replace the org's coaching points + proof items.
  await admin.from('coaching_points').delete().eq('organization_id', orgId);
  await admin.from('proof_items').delete().eq('organization_id', orgId);
  const cp = await admin.from('coaching_points').insert([
    {
      organization_id: orgId,
      content:
        'Friendly, concise, value-first tone. Lead with the prospect’s context. One clear CTA. No hype.',
    },
    {
      organization_id: orgId,
      content:
        'We sell developer-productivity tooling to SaaS engineering teams; emphasize CI/CD speed and shipping velocity.',
    },
  ]);
  if (cp.error) throw cp.error;
  const pi = await admin.from('proof_items').insert([
    {
      organization_id: orgId,
      category: 'customer',
      title: 'Nimbus Labs',
      body: 'Helped a 200-person SaaS engineering org cut CI pipeline time by 40%.',
    },
    {
      organization_id: orgId,
      category: 'case_study',
      title: 'Cirrus',
      body: 'Reduced deploy lead time from days to hours for a high-growth fintech.',
    },
  ]);
  if (pi.error) throw pi.error;

  // Leads (idempotent): upsert ~5 people with stable external_ids.
  const people = [
    {
      ext: 'demo:person:1',
      full: 'Jordan Lee',
      first: 'Jordan',
      last: 'Lee',
      title: 'CTO',
      sen: 'c_level',
      dept: 'engineering',
      company: 'Nimbus Labs',
      loc: 'San Francisco',
    },
    {
      ext: 'demo:person:2',
      full: 'Robin Park',
      first: 'Robin',
      last: 'Park',
      title: 'VP Engineering',
      sen: 'vp',
      dept: 'engineering',
      company: 'Cirrus',
      loc: 'Austin',
    },
    {
      ext: 'demo:person:3',
      full: 'Sam Rivera',
      first: 'Sam',
      last: 'Rivera',
      title: 'Director of Platform',
      sen: 'director',
      dept: 'engineering',
      company: 'Stratus',
      loc: 'New York',
    },
    {
      ext: 'demo:person:4',
      full: 'Avery Chen',
      first: 'Avery',
      last: 'Chen',
      title: 'Head of DevOps',
      sen: 'director',
      dept: 'operations',
      company: 'Cumulus',
      loc: 'Seattle',
    },
    {
      ext: 'demo:person:5',
      full: 'Morgan Diaz',
      first: 'Morgan',
      last: 'Diaz',
      title: 'Engineering Manager',
      sen: 'manager',
      dept: 'engineering',
      company: 'Altostratus',
      loc: 'Denver',
    },
  ];
  const rows = people.map((p) => ({
    organization_id: orgId,
    provider: 'seed',
    external_id: p.ext,
    first_name: p.first,
    last_name: p.last,
    full_name: p.full,
    // Demo email on a reserved, non-deliverable .example domain (RFC 2606): unmistakably demo, and
    // safe — even a hypothetical go-live fail-closes on these (verification can't pass them).
    email: `${p.first}.${p.last}@${demoDomain(p.company)}`.toLowerCase(),
    title: p.title,
    seniority: p.sen,
    department: p.dept,
    company_name: p.company,
    location: p.loc,
    country: 'US',
    source: 'find_leads',
  }));
  const up = await admin
    .from('people')
    .upsert(rows, { onConflict: 'organization_id,provider,external_id' })
    .select('id, external_id');
  if (up.error) throw up.error;
  const peopleIds = (up.data ?? []).map((r) => r.id as string);

  // ---- Sending surface: a labeled sandbox mailbox, warmed via the REAL classifyWarmth path ----
  // With no SMARTLEAD_API_KEY, createSmartleadClient() returns the sandbox simulator (Slice 4.0a):
  // sync creates an unmistakably-demo mailbox, the warmup refresh promotes it to 'warm' through the
  // real warmth logic. Nothing here touches a real provider. (With a real key, this syncs real
  // accounts — the genuine go-live behavior.)
  const senderName = 'Ava (demo)';
  const existingSender = await admin
    .from('senders')
    .select('id')
    .eq('organization_id', orgId)
    .eq('display_name', senderName)
    .maybeSingle();
  if (existingSender.error) throw existingSender.error;
  let senderId = existingSender.data?.id as string | undefined;
  if (!senderId) {
    const s = await admin
      .from('senders')
      .insert({
        organization_id: orgId,
        user_id: userId,
        display_name: senderName,
        status: 'active',
      })
      .select('id')
      .single();
    if (s.error) throw s.error;
    senderId = s.data.id as string;
  }

  const client = createSmartleadClient();
  const sync = await syncMailboxes(admin, orgId, client);
  for (const mailboxId of sync.mailboxIds) {
    await refreshMailboxWarmup(admin, client, mailboxId);
  }
  // Link the synced mailbox(es) to the demo sender + mark primary (best-effort; for the Team view).
  if (sync.mailboxIds.length > 0) {
    await admin
      .from('mailboxes')
      .update({ sender_id: senderId, is_primary: true })
      .eq('organization_id', orgId);
  }

  // ---- List + cold-outbound campaign from the demo leads ----
  const listName = 'Demo — Engineering leaders';
  const existingList = await admin
    .from('lists')
    .select('id')
    .eq('organization_id', orgId)
    .eq('name', listName)
    .maybeSingle();
  if (existingList.error) throw existingList.error;
  let listId = existingList.data?.id as string | undefined;
  if (!listId) {
    const l = await admin
      .from('lists')
      .insert({ organization_id: orgId, name: listName, entity_type: 'person' })
      .select('id')
      .single();
    if (l.error) throw l.error;
    listId = l.data.id as string;
  }
  if (peopleIds.length > 0) {
    const members = peopleIds.map((id) => ({
      organization_id: orgId,
      list_id: listId,
      entity_type: 'person',
      entity_id: id,
    }));
    const lm = await admin
      .from('list_members')
      .upsert(members, { onConflict: 'list_id,entity_type,entity_id', ignoreDuplicates: true });
    if (lm.error) throw lm.error;
  }

  const campaignName = 'Demo — Cold outbound';
  const existingCampaign = await admin
    .from('campaigns')
    .select('id')
    .eq('organization_id', orgId)
    .eq('name', campaignName)
    .maybeSingle();
  if (existingCampaign.error) throw existingCampaign.error;
  let campaignId = existingCampaign.data?.id as string | undefined;
  if (!campaignId) {
    const c = await admin
      .from('campaigns')
      .insert({
        organization_id: orgId,
        sender_id: senderId,
        name: campaignName,
        campaign_type: 'cold_outbound',
        list_id: listId,
        status: 'draft',
      })
      .select('id')
      .single();
    if (c.error) throw c.error;
    campaignId = c.data.id as string;
    const step = await admin.from('campaign_steps').insert({
      organization_id: orgId,
      campaign_id: campaignId,
      step_number: 1,
      channel: 'email',
      delay_days: 0,
      body_mode: 'ai_grounded',
    });
    if (step.error) throw step.error;
  }

  // ---- Drive launch → enroll → (if an LLM is configured) grounded dry-run drafts in Engage ----
  // launchCampaign enrolls the list as 'pending' + flips the campaign active. Drafting needs an LLM
  // provider (complete() has no live stub); guarded so the seed degrades honestly without one. The
  // verifier is passed as null so the demo's .example emails skip verification (they are demo data,
  // never really sent). prepareEnrollment → 'awaiting_approval' drafts; sending stays DRY-RUN.
  await launchCampaign(admin, { id: campaignId, organization_id: orgId, list_id: listId });
  const hasLlm = !!(env.ANTHROPIC_API_KEY || env.DEEPSEEK_API_KEY);
  let drafted = 0;
  if (hasLlm) {
    const pend = await admin
      .from('enrollments')
      .select('id, organization_id, campaign_id, lead_type, lead_id, status, current_step, task_id')
      .eq('campaign_id', campaignId)
      .eq('status', 'pending');
    if (pend.error) throw pend.error;
    for (const e of pend.data ?? []) {
      try {
        const res = await prepareEnrollment(
          admin,
          e as EnrollmentRecord & { lead_type: LeadType },
          {},
          null, // skip verification for demo .example leads (never really sent)
        );
        if (res.outcome === 'prepared') drafted += 1;
      } catch (err) {
        console.error('[seed-demo] draft generation failed for enrollment', e.id, err);
      }
    }
  }

  // Verify the credentials actually work.
  const signin = await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (signin.error || !signin.data.session) {
    throw signin.error ?? new Error('demo sign-in failed after seeding');
  }

  console.log('\n========================================');
  console.log('  Velora demo account seeded ✅');
  console.log('========================================');
  console.log(`  auth user:   ${created ? 'created' : 'recovered (already registered)'}`);
  console.log(`  email:       ${EMAIL}`);
  console.log(`  password:    ${PASSWORD}`);
  console.log(`  org id:      ${orgId}`);
  console.log(`  leads:       ${rows.length} people · KB: 2 coaching + 2 proof`);
  console.log(
    `  mailbox:     ${sync.synced} sandbox mailbox (warmed via the real path; demo affordance, not a real account)`,
  );
  console.log(`  campaign:    "${campaignName}" (cold_outbound, dry-run) over "${listName}"`);
  console.log(
    hasLlm
      ? `  drafts:      ${drafted} grounded dry-run drafts in Engage (awaiting approval)`
      : '  drafts:      none yet — set ANTHROPIC_API_KEY/DEEPSEEK_API_KEY, then drafts generate on the next executor run',
  );
  console.log('  sending:     OFF · dry-run (no real email; flip is a deliberate runbook act)');
  console.log('  → log in to the frontend with the email + password above.');
  console.log('========================================\n');
}

main().catch((err) => {
  console.error('seed-demo failed:', err);
  process.exit(1);
});
