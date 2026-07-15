import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');
const positiveIntegerString = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive());

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  AUTH_PEPPER: z.string().min(32, 'AUTH_PEPPER must contain at least 32 characters'),
  PUBLIC_APP_ORIGIN: z.url('PUBLIC_APP_ORIGIN must be a valid URL'),
  SMTP_HOST: z.string().min(1, 'SMTP_HOST is required'),
  SMTP_PORT: positiveIntegerString.pipe(z.number().max(65_535)).default(587),
  SMTP_FROM: z.string().min(1, 'SMTP_FROM is required'),
  SMTP_SECURE: booleanString.default(false),
  SMTP_USERNAME: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  COOKIE_SECURE: booleanString.default(true),
  TRUST_PROXY: z.string().default('').superRefine((value, context) => {
    const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (entries.some((entry) => !/^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/.test(entry))) {
      context.addIssue({ code: 'custom', message: 'TRUST_PROXY must list explicit IP addresses or CIDR networks' });
    }
  }),
  SESSION_COOKIE_NAME: z.string().min(1).default('polar_session'),
  SESSION_TTL_SECONDS: positiveIntegerString.default(30 * 24 * 60 * 60),
  VERIFICATION_TTL_SECONDS: positiveIntegerString.default(10 * 60),
  WORKFLOW_ENDPOINT_OVERRIDE: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.url('WORKFLOW_ENDPOINT_OVERRIDE must be a valid URL').optional(),
  ),
  WORKFLOW_TIMEOUT_MS: positiveIntegerString.default(60_000),
}).strict().superRefine((value, context) => {
  const origin = new URL(value.PUBLIC_APP_ORIGIN);
  const normalizedInput = value.PUBLIC_APP_ORIGIN.replace(/\/$/, '');

  if (origin.origin !== normalizedInput) {
    context.addIssue({
      code: 'custom',
      path: ['PUBLIC_APP_ORIGIN'],
      message: 'PUBLIC_APP_ORIGIN must contain only scheme, host, and optional port',
    });
  }

  if (value.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    context.addIssue({
      code: 'custom',
      path: ['PUBLIC_APP_ORIGIN'],
      message: 'PUBLIC_APP_ORIGIN must use https in production',
    });
  }

  if (value.NODE_ENV === 'production' && !value.COOKIE_SECURE) {
    context.addIssue({
      code: 'custom',
      path: ['COOKIE_SECURE'],
      message: 'COOKIE_SECURE must be true in production',
    });
  }

  if (origin.protocol === 'http:' && value.COOKIE_SECURE) {
    context.addIssue({
      code: 'custom',
      path: ['COOKIE_SECURE'],
      message: 'COOKIE_SECURE=false must be explicit when PUBLIC_APP_ORIGIN uses http',
    });
  }

  const hasSmtpUsername = Boolean(value.SMTP_USERNAME);
  const hasSmtpPassword = Boolean(value.SMTP_PASSWORD);
  if (hasSmtpUsername !== hasSmtpPassword) {
    context.addIssue({
      code: 'custom',
      path: ['SMTP_USERNAME'],
      message: 'SMTP_USERNAME and SMTP_PASSWORD must be configured together',
    });
  }
});

const environmentKeys = Object.keys(environmentSchema.shape) as Array<keyof typeof environmentSchema.shape>;

export type NativeWebConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: Record<string, string | undefined> = process.env) {
  const selectedEnvironment = Object.fromEntries(
    environmentKeys
      .filter((key) => environment[key] !== undefined)
      .map((key) => [key, environment[key]]),
  );
  const parsed = environmentSchema.parse(selectedEnvironment);

  return {
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    authPepper: parsed.AUTH_PEPPER,
    publicAppOrigin: new URL(parsed.PUBLIC_APP_ORIGIN).origin,
    smtp: {
      host: parsed.SMTP_HOST,
      port: parsed.SMTP_PORT,
      secure: parsed.SMTP_SECURE,
      from: parsed.SMTP_FROM,
      ...(parsed.SMTP_USERNAME && parsed.SMTP_PASSWORD
        ? { auth: { user: parsed.SMTP_USERNAME, pass: parsed.SMTP_PASSWORD } }
        : {}),
    },
    cookie: {
      name: parsed.SESSION_COOKIE_NAME,
      secure: parsed.COOKIE_SECURE,
      httpOnly: true as const,
      sameSite: 'lax' as const,
      path: '/' as const,
    },
    trustProxy: parsed.TRUST_PROXY
      ? parsed.TRUST_PROXY.split(',').map((entry) => entry.trim()).filter(Boolean)
      : false,
    sessionTtlSeconds: parsed.SESSION_TTL_SECONDS,
    verificationTtlSeconds: parsed.VERIFICATION_TTL_SECONDS,
    workflowEndpointOverride: parsed.WORKFLOW_ENDPOINT_OVERRIDE ?? null,
    workflowTimeoutMs: parsed.WORKFLOW_TIMEOUT_MS,
    rateLimits: {
      registration: { max: 5, timeWindowMs: 15 * 60 * 1_000 },
      login: { max: 10, timeWindowMs: 15 * 60 * 1_000 },
      verification: { max: 10, timeWindowMs: 15 * 60 * 1_000 },
      resend: { max: 10, timeWindowMs: 60 * 60 * 1_000 },
      command: { max: 30, timeWindowMs: 60 * 1_000 },
    },
  };
}
