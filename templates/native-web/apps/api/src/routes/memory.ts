import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { clearSessionCookie, hasValidOrigin, readSessionToken } from '../auth/session.js';
import type { NativeWebConfig } from '../config.js';
import type { MemoryRepository } from '../memory/repository.js';

const querySchema = z.object({ thread: z.string().uuid().optional() }).strict();
const paramsSchema = z.object({ proposalId: z.string().uuid() }).strict();
const bodySchema = z.object({ decision: z.enum(['adopted', 'rejected']) }).strict();

export async function registerMemoryRoutes(app: FastifyInstance, options: {
  config: NativeWebConfig; authService: AuthService; memoryRepository: MemoryRepository;
}) {
  const { config, authService, memoryRepository } = options;
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
  app.get('/api/memory-proposals', async (request, reply) => {
    const sessionUser = await user(request, reply);
    const query = querySchema.safeParse(request.query);
    if (!sessionUser) return;
    if (!query.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return { proposals: await memoryRepository.list(sessionUser.id, query.data.thread) };
  });
  app.post('/api/memory-proposals/:proposalId/decision', async (request, reply) => {
    if (!hasValidOrigin(request, config.publicAppOrigin)) return reply.code(403).send({ error: { code: 'INVALID_ORIGIN' } });
    const sessionUser = await user(request, reply);
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!sessionUser) return;
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    const result = await memoryRepository.decide(sessionUser.id, params.data.proposalId, body.data.decision, new Date());
    if (!result) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    if (result.alreadyDecided) return reply.code(409).send({ error: { code: 'PROPOSAL_ALREADY_DECIDED' }, proposal: result.proposal });
    return result;
  });
}
