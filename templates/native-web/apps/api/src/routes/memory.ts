import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { clearSessionCookie, hasValidOrigin, readSessionToken } from '../auth/session.js';
import type { NativeWebConfig } from '../config.js';
import type { MemoryService } from '../memory/service.js';

const querySchema = z.union([
  z.object({ scope: z.literal('user') }).strict(),
  z.object({ scope: z.literal('context'), context: z.string().uuid() }).strict(),
]);
const paramsSchema = z.object({ memoryId: z.string().uuid() }).strict();
const evidenceSchema = z.object({
  kind: z.string().min(1).max(200),
  id: z.string().min(1).max(500),
  excerpt: z.string().max(2000).optional(),
}).strict();
const reviseSchema = z.object({
  value: z.unknown(),
  expectedVersion: z.number().int().min(1),
  evidence: z.array(evidenceSchema).max(100).optional(),
}).strict().refine((input) => Object.hasOwn(input, 'value'));
const invalidateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(1).max(2000),
}).strict();

export async function registerMemoryRoutes(app: FastifyInstance, options: {
  config: NativeWebConfig; authService: AuthService; memoryService: MemoryService;
}) {
  const { config, authService, memoryService } = options;
  async function user(request: FastifyRequest, reply: FastifyReply) {
    const token = readSessionToken(request, config.cookie.name);
    const sessionUser = token ? await authService.getSessionUser(token) : null;
    if (!sessionUser) {
      if (token) clearSessionCookie(reply, config);
      reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
      return null;
    }
    return sessionUser;
  }
  app.get('/api/memory', async (request, reply) => {
    const sessionUser = await user(request, reply);
    const query = querySchema.safeParse(request.query);
    if (!sessionUser) return;
    if (!query.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    const input = query.data.scope === 'user'
      ? { scope: 'user' as const }
      : { scope: 'context' as const, contextId: query.data.context };
    return { memories: await memoryService.list(sessionUser.id, input) };
  });

  app.get('/api/memory/:memoryId/versions', async (request, reply) => {
    const sessionUser = await user(request, reply);
    const params = paramsSchema.safeParse(request.params);
    if (!sessionUser) return;
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return { versions: await memoryService.listVersions(sessionUser.id, params.data.memoryId) };
  });

  app.patch('/api/memory/:memoryId', async (request, reply) => {
    if (!hasValidOrigin(request, config.publicAppOrigin)) return reply.code(403).send({ error: { code: 'INVALID_ORIGIN' } });
    const sessionUser = await user(request, reply);
    const params = paramsSchema.safeParse(request.params);
    const body = reviseSchema.safeParse(request.body);
    if (!sessionUser) return;
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return { memory: await memoryService.revise(sessionUser.id, params.data.memoryId, {
      value: body.data.value,
      expectedVersion: body.data.expectedVersion,
      ...(body.data.evidence === undefined ? {} : { evidence: body.data.evidence }),
    }) };
  });

  app.delete('/api/memory/:memoryId', async (request, reply) => {
    if (!hasValidOrigin(request, config.publicAppOrigin)) return reply.code(403).send({ error: { code: 'INVALID_ORIGIN' } });
    const sessionUser = await user(request, reply);
    const params = paramsSchema.safeParse(request.params);
    const body = invalidateSchema.safeParse(request.body);
    if (!sessionUser) return;
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return { memory: await memoryService.invalidate(sessionUser.id, params.data.memoryId, body.data) };
  });
}
