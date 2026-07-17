import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { clearSessionCookie, hasValidOrigin, readSessionToken } from '../auth/session.js';
import type { NativeWebConfig } from '../config.js';
import type { DomainService } from '../domain/service.js';

const uuid = z.string().uuid();
const title = z.string();
const contextParams = z.object({ contextId: uuid }).strict();
const routeParams = z.object({ routeId: uuid }).strict();
const threadParams = z.object({ threadId: uuid }).strict();
const conversationParams = z.object({ conversationId: uuid }).strict();
const routeQuery = z.object({
  checkpoint: uuid.optional(),
}).strict();
const createContextBody = z.object({ title }).strict();
const renameContextBody = z.object({ title }).strict();
const createConversationBody = z.object({}).strict();
const updateConversationBody = z.object({
  title: title.optional(),
  status: z.enum(['active', 'archived']).optional(),
}).strict().refine((value) => value.title !== undefined || value.status !== undefined);
const createThreadBody = z.object({
  stageKey: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title,
}).strict();
const updateThreadBody = z.object({
  title: title.optional(),
  status: z.enum(['active', 'archived']).optional(),
}).strict().refine((value) => value.title !== undefined || value.status !== undefined);
const branchRouteBody = z.object({ sourceCheckpointId: uuid, name: title }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(value);
  if (!result.success) {
    reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return null;
  }
  return result.data;
}

export async function registerDomainRoutes(
  app: FastifyInstance,
  options: { config: NativeWebConfig; authService: AuthService; domainService: DomainService },
) {
  const { config, authService, domainService } = options;

  async function user(request: FastifyRequest, reply: FastifyReply) {
    const token = readSessionToken(request, config.cookie.name);
    if (!token) {
      reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
      return null;
    }
    const sessionUser = await authService.getSessionUser(token);
    if (!sessionUser) {
      clearSessionCookie(reply, config);
      reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
      return null;
    }
    return sessionUser;
  }

  async function mutationUser(request: FastifyRequest, reply: FastifyReply) {
    if (!hasValidOrigin(request, config.publicAppOrigin)) {
      reply.code(403).send({ error: { code: 'INVALID_ORIGIN' } });
      return null;
    }
    return user(request, reply);
  }

  app.get('/api/contexts', async (request, reply) => {
    const sessionUser = await user(request, reply);
    if (!sessionUser) return;
    return { contexts: await domainService.listContexts(sessionUser.id) };
  });

  app.post('/api/contexts', async (request, reply) => {
    const sessionUser = await mutationUser(request, reply);
    if (!sessionUser) return;
    const body = parse(createContextBody, request.body, reply);
    if (!body) return;
    return reply.code(201).send(await domainService.createContext(sessionUser.id, body));
  });

  app.get('/api/contexts/:contextId/workspace', async (request, reply) => {
    const sessionUser = await user(request, reply);
    if (!sessionUser) return;
    const params = parse(contextParams, request.params, reply);
    if (!params) return;
    return domainService.getContextWorkspace(sessionUser.id, params.contextId);
  });

  app.patch('/api/contexts/:contextId', async (request, reply) => {
    const sessionUser = await mutationUser(request, reply);
    if (!sessionUser) return;
    const params = parse(contextParams, request.params, reply);
    const body = parse(renameContextBody, request.body, reply);
    if (!params || !body) return;
    return domainService.renameContext(sessionUser.id, params.contextId, body);
  });

  app.get('/api/routes/:routeId/workspace', async (request, reply) => {
    const sessionUser = await user(request, reply);
    if (!sessionUser) return;
    const params = parse(routeParams, request.params, reply);
    const query = parse(routeQuery, request.query, reply);
    if (!params || !query) return;
    return domainService.getRouteWorkspace(sessionUser.id, params.routeId, {
      checkpointId: query.checkpoint,
    });
  });

  app.post('/api/routes/:routeId/conversations', async (request, reply) => {
    const sessionUser = await mutationUser(request, reply);
    if (!sessionUser) return;
    const params = parse(routeParams, request.params, reply);
    const body = parse(createConversationBody, request.body, reply);
    if (!params || !body) return;
    return reply.code(201).send(await domainService.createConversation(sessionUser.id, params.routeId));
  });

  app.patch('/api/conversations/:conversationId', async (request, reply) => {
    const sessionUser = await mutationUser(request, reply);
    if (!sessionUser) return;
    const params = parse(conversationParams, request.params, reply);
    const body = parse(updateConversationBody, request.body, reply);
    if (!params || !body) return;
    return domainService.updateConversation(sessionUser.id, params.conversationId, body);
  });

  app.post('/api/routes/:routeId/threads', async (request, reply) => {
    const sessionUser = await mutationUser(request, reply);
    if (!sessionUser) return;
    const params = parse(routeParams, request.params, reply);
    const body = parse(createThreadBody, request.body, reply);
    if (!params || !body) return;
    return reply.code(201).send(await domainService.createThread(sessionUser.id, params.routeId, body));
  });

  app.patch('/api/threads/:threadId', async (request, reply) => {
    const sessionUser = await mutationUser(request, reply);
    if (!sessionUser) return;
    const params = parse(threadParams, request.params, reply);
    const body = parse(updateThreadBody, request.body, reply);
    if (!params || !body) return;
    return domainService.updateThread(sessionUser.id, params.threadId, body);
  });

  app.post('/api/contexts/:contextId/routes', async (request, reply) => {
    const sessionUser = await mutationUser(request, reply);
    if (!sessionUser) return;
    const params = parse(contextParams, request.params, reply);
    const body = parse(branchRouteBody, request.body, reply);
    if (!params || !body) return;
    return reply.code(201).send(await domainService.branchRoute(sessionUser.id, params.contextId, body));
  });
}
