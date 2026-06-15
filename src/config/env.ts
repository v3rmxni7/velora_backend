import 'dotenv/config';
import { z } from 'zod';

// The ONLY place process.env is read. Everything else imports `env` from here.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('*'),

  // Supabase — optional in Phase 0 so the app boots without a live DB.
  SUPABASE_URL: z.url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Inngest
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  // LLM providers (BYOK — used from Phase 1).
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  // Cheap tier (Slice 3b) — DeepSeek via the OpenAI-compatible API.
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().default('https://api.deepseek.com'),

  // Scraping (Firecrawl) — KB ingestion, Phase 1 Slice 1.
  FIRECRAWL_API_KEY: z.string().optional(),

  // Sending substrate (Smartlead) — Phase 2. Read-only in Slice 2.1 (mailboxes + warmup).
  SMARTLEAD_API_KEY: z.string().optional(),
  SMARTLEAD_API_URL: z.string().default('https://server.smartlead.ai/api/v1'),

  // Email verification (MillionVerifier) — Phase 2 Slice 2.4. Absent → verification skipped.
  MILLIONVERIFIER_API_KEY: z.string().optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:\n');
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = Object.freeze(parsed.data);
export type Env = typeof env;
