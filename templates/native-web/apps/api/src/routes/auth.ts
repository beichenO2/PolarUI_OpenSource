import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import {
  clearSessionCookie,
  hasValidOrigin,
  readSessionToken,
  setSessionCookie,
  toIpPrefix,
} from '../auth/session.js';
import type { NativeWebConfig } from '../config.js';

const registerSchema = z.object({
  email: z.string(),
  username: z.string(),
  password: z.string(),
}).strict();
const verifySchema = z.object({ email: z.string(), code: z.string() }).strict();
const resendSchema = z.object({ email: z.string() }).strict();
const loginSchema = z.object({ identifier: z.string(), password: z.string() }).strict();

function requireOrigin(config: NativeWebConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hasValidOrigin(request, config.publicAppOrigin)) {
      return reply.code(403).send({ error: { code: 'INVALID_ORIGIN' } });
    }
  };
}

function routeRateLimit(limit: { max: number; timeWindowMs: number }) {
  return { max: limit.max, timeWindow: limit.timeWindowMs };
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return null;
  }
  return parsed.data;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: { config: NativeWebConfig; authService: AuthService },
) {
  const { config, authService } = options;
  const originGuard = requireOrigin(config);

  app.post('/api/auth/register', {
    preHandler: originGuard,
    config: { rateLimit: routeRateLimit(config.rateLimits.registration) },
  }, async (request, reply) => {
    const body = parseBody(registerSchema, request.body, reply);
    if (!body) return;
    const result = await authService.register(body);
    if (result.ok) return reply.code(201).send(result);
    if (result.code === 'EMAIL_TAKEN' || result.code === 'USERNAME_TAKEN') {
      return reply.code(409).send({ error: { code: result.code } });
    }
    if (result.code === 'MAIL_DELIVERY_FAILED') {
      return reply.code(503).send({ error: { code: result.code } });
    }
    return reply.code(400).send({ error: { code: result.code } });
  });

  app.post('/api/auth/verify-email', {
    preHandler: originGuard,
    config: { rateLimit: routeRateLimit(config.rateLimits.verification) },
  }, async (request, reply) => {
    const body = parseBody(verifySchema, request.body, reply);
    if (!body) return;
    const result = await authService.verifyEmail(body);
    if (result.ok) return reply.send({ ok: true });
    return reply.code(400).send({ error: { code: result.code } });
  });

  app.post('/api/auth/verification/resend', {
    preHandler: originGuard,
    config: { rateLimit: routeRateLimit(config.rateLimits.resend) },
  }, async (request, reply) => {
    const body = parseBody(resendSchema, request.body, reply);
    if (!body) return;
    await authService.resendVerification(body);
    return reply.code(202).send({ accepted: true });
  });

  app.post('/api/auth/login', {
    preHandler: originGuard,
    config: { rateLimit: routeRateLimit(config.rateLimits.login) },
  }, async (request, reply) => {
    const body = parseBody(loginSchema, request.body, reply);
    if (!body) return;
    const result = await authService.login({
      ...body,
      userAgent: request.headers['user-agent'] ?? null,
      ipPrefix: toIpPrefix(request.ip),
    });
    if (!result.ok) {
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS' } });
    }
    setSessionCookie(reply, result.sessionToken, config);
    return reply.send({ user: result.user });
  });

  app.get('/api/auth/session', async (request, reply) => {
    const token = readSessionToken(request, config.cookie.name);
    if (!token) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    const user = await authService.getSessionUser(token);
    if (!user) {
      clearSessionCookie(reply, config);
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }
    return reply.send({ user });
  });

  app.post('/api/auth/logout', { preHandler: originGuard }, async (request, reply) => {
    const token = readSessionToken(request, config.cookie.name);
    if (token) await authService.logout(token);
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });
}
