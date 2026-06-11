import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/config/env.js';

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
    .upsert(rows, { onConflict: 'organization_id,provider,external_id' });
  if (up.error) throw up.error;

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
  console.log('  → log in to the frontend with the email + password above.');
  console.log('========================================\n');
}

main().catch((err) => {
  console.error('seed-demo failed:', err);
  process.exit(1);
});
