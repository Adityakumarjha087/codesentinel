import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: bool(false),

    DATABASE_URL: z.string().default('postgres://codesentinel:codesentinel@localhost:20310/codesentinel'),
    /** `pglite` runs an in-process Postgres (with pgvector) — used by tests and zero-dependency local runs. */
    DATABASE_DRIVER: z.enum(['pg', 'pglite']).default('pg'),
    REDIS_URL: optionalString,
    QUEUE_MODE: z.enum(['bullmq', 'inline']).default('inline'),
    /** When true the API process also consumes the review queue (single-process deployments). */
    RUN_WORKER: bool(true),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    AUTO_MIGRATE: bool(true),

    FRONTEND_URL: z.string().default('http://localhost:20300'),
    CORS_ORIGINS: z.string().default('http://localhost:20300'),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

    JWT_SECRET: z.string().min(16).default('dev-only-change-me-access-secret'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
    COOKIE_SECURE: bool(false),
    AUTH_DEV_LOGIN: bool(true),
    ADMIN_GITHUB_LOGINS: z.string().default(''),

    GITHUB_MODE: z.enum(['mock', 'live']).default('mock'),
    GITHUB_APP_ID: optionalString,
    GITHUB_PRIVATE_KEY: optionalString,
    GITHUB_WEBHOOK_SECRET: z.string().min(1).default('codesentinel-dev-webhook-secret'),
    GITHUB_CLIENT_ID: optionalString,
    GITHUB_CLIENT_SECRET: optionalString,
    GITHUB_OAUTH_CALLBACK_URL: z.string().default('http://localhost:20300/api/auth/github/callback'),
    GITHUB_API_URL: z.string().default('https://api.github.com'),
    GITHUB_WEB_URL: z.string().default('https://github.com'),

    LLM_PROVIDER: z.enum(['mock', 'openai', 'anthropic', 'gemini', 'ollama']).default('mock'),
    LLM_MODEL: optionalString,
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4096),
    OPENAI_API_KEY: optionalString,
    OPENAI_BASE_URL: optionalString,
    ANTHROPIC_API_KEY: optionalString,
    ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    GEMINI_API_KEY: optionalString,
    OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),

    EMBEDDING_PROVIDER: z.enum(['hash', 'openai', 'ollama']).default('hash'),
    EMBEDDING_MODEL: optionalString,

    DEFAULT_MONTHLY_TOKEN_BUDGET: z.coerce.number().int().positive().default(2_000_000),
    MAX_FILE_CHANGED_LINES: z.coerce.number().int().positive().default(1500),
    MAX_REVIEW_INPUT_TOKENS: z.coerce.number().int().positive().default(60_000),
    MAX_INDEX_FILES: z.coerce.number().int().positive().default(400),
  })
  .superRefine((env, ctx) => {
    if (env.QUEUE_MODE === 'bullmq' && !env.REDIS_URL) {
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'REDIS_URL is required when QUEUE_MODE=bullmq' });
    }
    if (env.GITHUB_MODE === 'live' && (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['GITHUB_APP_ID'], message: 'GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required when GITHUB_MODE=live' });
    }
    const keyFor = { openai: env.OPENAI_API_KEY, anthropic: env.ANTHROPIC_API_KEY, gemini: env.GEMINI_API_KEY } as const;
    if (env.LLM_PROVIDER in keyFor && !keyFor[env.LLM_PROVIDER as keyof typeof keyFor]) {
      ctx.addIssue({ code: 'custom', path: ['LLM_PROVIDER'], message: `An API key is required for LLM_PROVIDER=${env.LLM_PROVIDER}` });
    }
    if (env.EMBEDDING_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['EMBEDDING_PROVIDER'], message: 'OPENAI_API_KEY is required for EMBEDDING_PROVIDER=openai' });
    }
    if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only')) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'Set a strong JWT_SECRET in production' });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
