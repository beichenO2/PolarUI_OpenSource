import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { clearSessionCookie, hasValidOrigin, readSessionToken } from '../auth/session.js';
import type { CommandRepository } from '../commands/repository.js';
import type { CommandService } from '../commands/service.js';
import type { NativeWebConfig } from '../config.js';

const uuid = z.string().uuid();
const paramsSchema = z.object({ threadId: uuid }).strict();
const commandParamsSchema = z.object({ commandId: uuid }).strict();
const actionKey = z.string().regex(/^[a-z][a-z0-9_]*$/);
const common = {
  commandId: uuid,
  content: z.string().max(20_000),
  baseCheckpointId: uuid,
  expectedCheckpointVersion: z.number().int().nonnegative(),
};
const commandBodySchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('message'), content: z.string().min(1).max(20_000) }).strict(),
  z.object({ ...common, kind: z.literal('named_action'), actionKey }).strict(),
  z.object({
    ...common,
    kind: z.literal('resume_interrupt'),
    interruptId: uuid,
    content: z.string().min(1).max(20_000),
  }).strict(),
]);

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    return null;
  }
  return parsed.data;
}

function frame(event: { sequence: number; eventType: string; payload: Record<string, unknown> }) {
  return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function registerCommandRoutes(
  app: FastifyInstance,
  options: {
    config: NativeWebConfig;
    authService: AuthService;
    commandService: CommandService;
    commandRepository: CommandRepository;
  },
) {
  const { config, authService, commandService, commandRepository } = options;
  const commandWindows = new Map<string, { startedAt: number; count: number }>();

  function consumeCommandCapacity(userId: string, reply: FastifyReply) {
    const now = Date.now();
    const limit = config.rateLimits.command;
    const current = commandWindows.get(userId);
    if (!current || now - current.startedAt >= limit.timeWindowMs) {
      commandWindows.set(userId, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= limit.max) {
      reply.code(429).send({ error: { code: 'RATE_LIMITED' } });
      return false;
    }
    current.count += 1;
    return true;
  }

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
    const sessionUser = await user(request, reply);
    if (!sessionUser || !consumeCommandCapacity(sessionUser.id, reply)) return null;
    return sessionUser;
  }

  app.get('/api/threads/:threadId/messages', async (request, reply) => {
    const sessionUser = await user(request, reply);
    if (!sessionUser) return;
    const params = parse(paramsSchema, request.params, reply);
    if (!params) return;
    const state = await commandRepository.listThreadState(sessionUser.id, params.threadId);
    if (!state) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    return state;
  });

  app.post('/api/threads/:threadId/commands', async (request, reply) => {
    const sessionUser = await mutationUser(request, reply);
    if (!sessionUser) return;
    const params = parse(paramsSchema, request.params, reply);
    const body = parse(commandBodySchema, request.body, reply);
    if (!params || !body) return;
    const receipt = await commandService.createCommand(sessionUser.id, params.threadId, body);
    setImmediate(() => { void commandService.executeCommand(receipt.commandId); });
    return reply.code(202).send({ commandId: receipt.commandId, eventUrl: receipt.eventUrl });
  });

  app.get('/api/commands/:commandId/events', async (request, reply) => {
    const sessionUser = await user(request, reply);
    if (!sessionUser) return;
    const params = parse(commandParamsSchema, request.params, reply);
    if (!params) return;
    const lastEventHeader = request.headers['last-event-id'];
    if (Array.isArray(lastEventHeader) ||
        (lastEventHeader !== undefined && !/^\d+$/.test(lastEventHeader))) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    }
    let cursor = lastEventHeader === undefined ? 0 : Number(lastEventHeader);
    if (!Number.isSafeInteger(cursor)) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
    }
    const initial = await commandRepository.listCommandEvents(sessionUser.id, params.commandId, cursor);
    if (!initial) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const initialState = initial;
    const userId = sessionUser.id;
    const commandId = params.commandId;

    async function* stream() {
      let state = initialState;
      let heartbeatAt = Date.now();
      while (true) {
        for (const event of state.events) {
          cursor = event.sequence;
          yield frame(event);
          if (event.eventType === 'command.finished') return;
        }
        if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'conflict') return;
        await delay(250);
        if (Date.now() - heartbeatAt >= 15_000) {
          yield ': heartbeat\n\n';
          heartbeatAt = Date.now();
        }
        const next = await commandRepository.listCommandEvents(userId, commandId, cursor);
        if (!next) return;
        state = next;
      }
    }

    reply.header('Content-Type', 'text/event-stream; charset=utf-8');
    reply.header('Cache-Control', 'no-cache, no-transform');
    reply.header('X-Accel-Buffering', 'no');
    reply.header('Connection', 'keep-alive');
    return reply.send(Readable.from(stream()));
  });
}
