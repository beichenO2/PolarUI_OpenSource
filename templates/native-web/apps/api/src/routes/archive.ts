import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { clearSessionCookie, readSessionToken } from '../auth/session.js';
import type { ArchiveRepository } from '../archive/repository.js';
import type { NativeWebConfig } from '../config.js';

const paramsSchema = z.object({ conversationId: z.string().uuid() }).strict();
export async function registerArchiveRoutes(app: FastifyInstance, options: {
  config: NativeWebConfig; authService: AuthService; archiveRepository: ArchiveRepository;
}) {
  const { config, authService, archiveRepository } = options;
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
  app.get('/api/archive/conversations', async (request, reply) => {
    const sessionUser = await user(request, reply);
    if (!sessionUser) return;
    return { conversations: await archiveRepository.list(sessionUser.id) };
  });
  app.get('/api/archive/conversations/:conversationId', async (request, reply) => {
    const sessionUser = await user(request, reply);
    const params = paramsSchema.safeParse(request.params);
    if (!sessionUser) return;
    if (!params.success) return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    const result = await archiveRepository.detail(sessionUser.id, params.data.conversationId);
    return result ?? reply.code(404).send({ error: { code: 'NOT_FOUND' } });
  });
}
