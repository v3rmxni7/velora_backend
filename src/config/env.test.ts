import { describe, expect, it } from 'vitest';
import { EnvSchema } from './env.js';

// F1 (audit): in production the prod-required vars hard-fail validation (the server refuses to boot
// with a clear, named error) rather than booting green-but-dead. In dev/test they stay optional.
// Tested via EnvSchema.safeParse directly so we never touch process.env or the module-load exit().
const prodBase = {
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://app.velora.example',
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  INNGEST_SIGNING_KEY: 'signkey',
  INNGEST_EVENT_KEY: 'eventkey',
};
const issuePaths = (r: ReturnType<typeof EnvSchema.safeParse>) =>
  r.success ? [] : r.error.issues.map((i) => String(i.path[0]));

describe('EnvSchema prod hard-fail (F1)', () => {
  it('a complete production env validates', () => {
    expect(EnvSchema.safeParse(prodBase).success).toBe(true);
  });

  it('production with a missing Supabase/Inngest var fails, naming the var', () => {
    for (const key of [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'INNGEST_SIGNING_KEY',
      'INNGEST_EVENT_KEY',
    ]) {
      const { [key]: _omit, ...rest } = prodBase as Record<string, string>;
      const res = EnvSchema.safeParse(rest);
      expect(res.success).toBe(false);
      expect(issuePaths(res)).toContain(key);
    }
  });

  it("production with CORS_ORIGIN='*' (the default) fails", () => {
    const res = EnvSchema.safeParse({ ...prodBase, CORS_ORIGIN: '*' });
    expect(res.success).toBe(false);
    expect(issuePaths(res)).toContain('CORS_ORIGIN');
  });

  it('production missing everything reports every required var + CORS', () => {
    const res = EnvSchema.safeParse({ NODE_ENV: 'production' }); // CORS_ORIGIN defaults to '*'
    expect(res.success).toBe(false);
    const paths = issuePaths(res);
    for (const key of [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'INNGEST_SIGNING_KEY',
      'INNGEST_EVENT_KEY',
      'CORS_ORIGIN',
    ]) {
      expect(paths).toContain(key);
    }
  });

  it('dev/test boot WITHOUT any of those vars (the refine is prod-gated)', () => {
    expect(EnvSchema.safeParse({}).success).toBe(true); // NODE_ENV defaults to 'development'
    expect(EnvSchema.safeParse({ NODE_ENV: 'test' }).success).toBe(true);
  });
});
