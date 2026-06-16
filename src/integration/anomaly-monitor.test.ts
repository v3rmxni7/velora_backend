import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type HealthThresholds, runAnomalySweep } from '../agents/sending/anomaly.js';
import { env } from '../config/env.js';

// Opt-in (RUN_DB_IT=1). Live DB, service-role. Proves Slice 3.5: the sweep auto-pauses (flips
// autonomy_enabled=false) any autonomy-on org that breaches its sending health, audits each pause,
// leaves healthy orgs alone, and is tenant-scoped. NO real email — it only reads metrics + flips a flag.
const ready =
  process.env.RUN_DB_IT === '1' && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_URL = env.SUPABASE_URL ?? '';
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const THRESHOLDS: HealthThresholds = { maxBounceRate: 0.05, minSends: 20, maxComplaints: 0 };

describe.skipIf(!ready)('Slice 3.5 — anomaly monitor auto-pauses autonomy on a breach', () => {
  const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stamp = Date.now();
  const orgIds: string[] = [];
  // labelled orgs seeded in beforeAll
  let orgBounce = ''; // autonomy on, bounce spike → should pause
  let orgComplaint = ''; // autonomy on, a complaint → should pause
  let orgHealthy = ''; // autonomy on, clean → should NOT pause
  let orgOff = ''; // autonomy OFF, bounce spike → not swept (no-op)

  async function makeOrg(autonomyEnabled: boolean): Promise<string> {
    const o = await admin
      .from('organizations')
      .insert({ name: `s35-${stamp}-${orgIds.length}`, autonomy_enabled: autonomyEnabled })
      .select('id')
      .single();
    if (o.error) throw o.error;
    const id = o.data.id as string;
    orgIds.push(id);
    return id;
  }
  async function thread(orgId: string): Promise<string> {
    const p = await admin
      .from('people')
      .insert({
        organization_id: orgId,
        provider: 'seed',
        external_id: `p:${orgId}`,
        full_name: 'Lead',
        source: 'find_leads',
      })
      .select('id')
      .single();
    if (p.error) throw p.error;
    const t = await admin
      .from('threads')
      .insert({
        organization_id: orgId,
        lead_type: 'person',
        lead_id: p.data.id as string,
        status: 'active',
      })
      .select('id')
      .single();
    if (t.error) throw t.error;
    return t.data.id as string;
  }
  // Seed `total` outbound messages, `bounced` of them bounced + `complained` complained, in-window.
  async function seedMessages(
    orgId: string,
    threadId: string,
    counts: { total: number; bounced?: number; complained?: number },
  ) {
    const { total, bounced = 0, complained = 0 } = counts;
    const rows = Array.from({ length: total }, (_, i) => ({
      organization_id: orgId,
      thread_id: threadId,
      direction: 'outbound',
      channel: 'email',
      status: i < bounced ? 'bounced' : i < bounced + complained ? 'complained' : 'sent',
      dedupe_key: `anom:${orgId}:${i}`,
    }));
    const r = await admin.from('messages').insert(rows);
    if (r.error) throw r.error;
  }

  let result: { swept: number; paused: number; errors: number };

  beforeAll(async () => {
    orgBounce = await makeOrg(true);
    orgComplaint = await makeOrg(true);
    orgHealthy = await makeOrg(true);
    orgOff = await makeOrg(false);

    // orgBounce: 20 sends, 2 bounced (10% > 5%, n >= 20) → breach.
    await seedMessages(orgBounce, await thread(orgBounce), { total: 20, bounced: 2 });
    // orgComplaint: 5 sends incl. 1 complaint → breach (any complaint).
    await seedMessages(orgComplaint, await thread(orgComplaint), { total: 5, complained: 1 });
    // orgHealthy: 20 sends, 0 bounced → no breach.
    await seedMessages(orgHealthy, await thread(orgHealthy), { total: 20 });
    // orgOff: a bounce spike, but autonomy is OFF → excluded from the sweep.
    await seedMessages(orgOff, await thread(orgOff), { total: 20, bounced: 10 });

    result = await runAnomalySweep(admin, THRESHOLDS, env.ANOMALY_WINDOW_HOURS);
  }, 180_000);

  afterAll(async () => {
    for (const id of orgIds) await admin.from('organizations').delete().eq('id', id);
  });

  async function autonomyOf(orgId: string): Promise<boolean> {
    const r = await admin.from('organizations').select('autonomy_enabled').eq('id', orgId).single();
    return r.data?.autonomy_enabled === true;
  }
  async function pauseAudits(orgId: string) {
    const r = await admin
      .from('autonomy_events')
      .select('reason, decision, confidence')
      .eq('organization_id', orgId)
      .eq('kind', 'auto_pause');
    if (r.error) throw r.error;
    return r.data ?? [];
  }

  it('bounce spike → autonomy paused + auto_pause audit naming the bounce_rate', async () => {
    expect(await autonomyOf(orgBounce)).toBe(false);
    const audits = await pauseAudits(orgBounce);
    expect(audits.length).toBe(1);
    expect(audits[0]?.decision).toBe('auto_pause');
    expect(audits[0]?.reason).toContain('bounce_rate');
  });

  it('a complaint → autonomy paused + auto_pause audit naming complaints', async () => {
    expect(await autonomyOf(orgComplaint)).toBe(false);
    expect((await pauseAudits(orgComplaint))[0]?.reason).toContain('complaints');
  });

  it('healthy org → NOT paused, no auto_pause audit', async () => {
    expect(await autonomyOf(orgHealthy)).toBe(true);
    expect((await pauseAudits(orgHealthy)).length).toBe(0);
  });

  it('tenant isolation: only breaching orgs flipped; the healthy org is untouched', async () => {
    // Proven by the per-org assertions above running off a SINGLE sweep over all orgs.
    expect(await autonomyOf(orgBounce)).toBe(false);
    expect(await autonomyOf(orgHealthy)).toBe(true);
    expect(result.paused).toBeGreaterThanOrEqual(2);
  });

  it('autonomy already OFF → excluded from the sweep, no-op, no audit', async () => {
    expect(await autonomyOf(orgOff)).toBe(false); // unchanged
    expect((await pauseAudits(orgOff)).length).toBe(0); // never evaluated → never paused/audited
  });
});
