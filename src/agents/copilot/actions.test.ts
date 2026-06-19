import { describe, expect, it } from 'vitest';
import {
  type CopilotActionCtx,
  WRITE_ACTION_NAMES,
  WRITE_ACTION_ROLES,
  WRITE_ACTIONS,
} from './actions.js';

// A ctx whose db throws if touched — proves the db-free validate() paths don't read the database.
const stubCtx = {
  db: new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('db touched');
      },
    },
  ),
  organizationId: 'org',
  userId: 'u',
} as unknown as CopilotActionCtx;

// Throwing accessor (WRITE_ACTIONS is a Record → index access is `T | undefined` under strict mode).
function act(name: string) {
  const a = WRITE_ACTIONS[name];
  if (!a) throw new Error(`missing action ${name}`);
  return a;
}

describe('WRITE_ACTIONS registry', () => {
  it('exposes the 5 owner/admin-gated actions', () => {
    expect([...WRITE_ACTION_NAMES].sort()).toEqual([
      'create_list',
      'launch_campaign',
      'pause_autonomy',
      'pause_campaign',
      'subscribe_signal',
    ]);
    expect(WRITE_ACTION_ROLES).toEqual(['owner', 'admin']);
  });

  it('every action declares a class + an args schema', () => {
    for (const a of Object.values(WRITE_ACTIONS)) {
      expect(['safe', 'spending', 'destructive']).toContain(a.actionClass);
      expect(a.argsSchema).toBeDefined();
    }
    expect(act('launch_campaign').actionClass).toBe('destructive');
  });

  it('launch_campaign requires a uuid campaignId (model args are not trusted)', () => {
    const s = act('launch_campaign').argsSchema;
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ campaignId: 'nope' }).success).toBe(false);
    expect(s.safeParse({ campaignId: '00000000-0000-0000-0000-000000000000' }).success).toBe(true);
  });

  it('create_list rejects an empty name and titles without a db', async () => {
    const s = act('create_list').argsSchema;
    expect(s.safeParse({ name: '', entityType: 'person' }).success).toBe(false);
    const args = { name: 'VIPs', entityType: 'person' as const };
    expect(s.safeParse(args).success).toBe(true);
    const v = await act('create_list').validate(args, stubCtx);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.title).toContain('VIPs');
  });

  it('pause_autonomy validates with no args or db', async () => {
    const v = await act('pause_autonomy').validate({}, stubCtx);
    expect(v.ok).toBe(true);
  });
});
