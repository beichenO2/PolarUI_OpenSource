import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CommandServiceError } from '../src/commands/service.js';

const origin = 'http://127.0.0.1:3920';
const manifest = {
  contract_version: '1.0' as const,
  product: { id: 'demo', name: 'Demo', context_label: '项目', route_label: '路线' },
  workflow: { id: 'demo', endpoint: 'http://workflow.test/run' },
  stages: [{
    key: 'discover', label: '发现', component_key: 'generic_chat' as const,
    internal_states: ['start'], actions: [{ key: 'adopt_thread', label: '采纳到当前路线' }],
  }],
};
const config = loadConfig({
  NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/test',
  AUTH_PEPPER: 'test-pepper-with-at-least-32-characters', PUBLIC_APP_ORIGIN: origin,
  COOKIE_SECURE: 'false', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025',
  SMTP_FROM: 'Demo <no-reply@example.test>',
});
const ids = {
  user: '10000000-0000-4000-8000-000000000001',
  thread: '10000000-0000-4000-8000-000000000002',
  command: '10000000-0000-4000-8000-000000000003',
  checkpoint: '10000000-0000-4000-8000-000000000004',
  context: '10000000-0000-4000-8000-000000000005',
  route: '10000000-0000-4000-8000-000000000006',
  interrupt: '10000000-0000-4000-8000-000000000007',
};
const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(overrides: {
  threadState?: unknown;
  eventReads?: unknown[];
  createError?: Error;
  commandLimit?: { max: number; timeWindowMs: number };
} = {}) {
  const repository = {
    listThreadState: vi.fn(async () => Object.hasOwn(overrides, 'threadState') ? overrides.threadState : {
      messages: [{
        id: 'message-1', commandId: ids.command, role: 'assistant', content: 'Persisted',
        sequence: 1, createdAt: new Date('2026-07-16T00:00:00.000Z'),
      }],
      pendingInterrupt: { id: 'interrupt-1', prompt: 'Approve?', actionKey: null, createdAt: new Date('2026-07-16T00:00:00.000Z') },
    }),
    listConversationState: vi.fn(async () => Object.hasOwn(overrides, 'threadState') ? overrides.threadState : {
      messages: [{
        id: 'message-1', commandId: ids.command, role: 'assistant', content: 'Persisted',
        sequence: 1, createdAt: new Date('2026-07-16T00:00:00.000Z'),
      }],
      pendingInterrupt: { id: 'interrupt-1', prompt: 'Approve?', actionKey: null, createdAt: new Date('2026-07-16T00:00:00.000Z') },
    }),
    listCommandEvents: vi.fn(async () => overrides.eventReads && overrides.eventReads.length > 0 ? overrides.eventReads.shift() : {
      status: 'succeeded',
      events: [
        { commandId: ids.command, sequence: 2, eventType: 'assistant.delta', payload: { delta: 'Answer' }, createdAt: new Date() },
        { commandId: ids.command, sequence: 3, eventType: 'command.finished', payload: { outcome: 'succeeded' }, createdAt: new Date() },
      ],
    }),
  };
  const commandService = {
    createCommand: vi.fn(async () => {
      if (overrides.createError) throw overrides.createError;
      return { commandId: ids.command, eventUrl: `/api/commands/${ids.command}/events`, replayed: false };
    }),
    executeCommand: vi.fn(async () => {}),
  };
  const authService = {
    getSessionUser: vi.fn(async (token: string) => token === 'token'
      ? { id: ids.user, email: 'owner@example.test', username: 'owner' }
      : null),
  };
  const app = buildApp({
    manifest, staticRoot: null, config: {
      ...config,
      rateLimits: {
        ...config.rateLimits,
        command: overrides.commandLimit ?? config.rateLimits.command,
      },
    },
    authService: authService as never,
    commandService: commandService as never,
    commandRepository: repository as never,
  });
  apps.push(app);
  return { app, repository, commandService };
}

const cookie = 'polar_session=token';
const commandBody = {
  commandId: ids.command, kind: 'message', content: 'Question',
  baseCheckpointId: ids.checkpoint, expectedCheckpointVersion: 0,
};
const workflowCommandBody = {
  commandId: ids.command,
  input: { type: 'message' as const, content: 'Question' },
  attachmentIds: [],
};

describe('workflow command routes', () => {
  it('requires authentication and same-origin command mutations', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: `/api/threads/${ids.thread}/messages` })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST', url: `/api/threads/${ids.thread}/commands`, headers: { cookie }, payload: commandBody,
    })).statusCode).toBe(403);
  });

  it('validates route UUIDs, command bodies, and hides inaccessible resources', async () => {
    const { app } = setup({ threadState: null });
    expect((await app.inject({ method: 'GET', url: '/api/threads/not-a-uuid/messages', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/threads/${ids.thread}/messages`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'POST', url: `/api/threads/${ids.thread}/commands`, headers: { cookie, origin },
      payload: { ...commandBody, unexpected: true },
    })).statusCode).toBe(400);
  });

  it('returns persisted messages and only the public interrupt fields', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: `/api/threads/${ids.thread}/messages`, headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      messages: [{ content: 'Persisted', createdAt: '2026-07-16T00:00:00.000Z' }],
      pendingInterrupt: { id: 'interrupt-1', prompt: 'Approve?' },
    });
    expect(response.body).not.toContain('cursor');
  });

  it('returns 202 then schedules execution independently from the POST request', async () => {
    const { app, commandService } = setup();
    const response = await app.inject({
      method: 'POST', url: `/api/threads/${ids.thread}/commands`, headers: { cookie, origin }, payload: commandBody,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ commandId: ids.command, eventUrl: `/api/commands/${ids.command}/events` });
    await vi.waitFor(() => expect(commandService.executeCommand).toHaveBeenCalledWith(ids.command));
  });

  it('maps command-id conflicts to structured 409 responses', async () => {
    const { app } = setup({ createError: new CommandServiceError('COMMAND_IN_PROGRESS', 409) });
    const response = await app.inject({
      method: 'POST', url: `/api/threads/${ids.thread}/commands`, headers: { cookie, origin }, payload: commandBody,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'COMMAND_IN_PROGRESS' } });
  });

  it('rate limits authenticated command mutations per user', async () => {
    const { app, commandService } = setup({ commandLimit: { max: 1, timeWindowMs: 60_000 } });
    const request = {
      method: 'POST' as const,
      url: `/api/threads/${ids.thread}/commands`,
      headers: { cookie, origin },
      payload: commandBody,
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    const limited = await app.inject({ ...request, payload: { ...commandBody, commandId: '10000000-0000-4000-8000-000000000005' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: { code: 'RATE_LIMITED' } });
    expect(commandService.createCommand).toHaveBeenCalledTimes(1);
  });

  it('replays persisted SSE events after Last-Event-ID with anti-buffering headers', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      method: 'GET', url: `/api/commands/${ids.command}/events`,
      headers: { cookie, 'last-event-id': '1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toBe('no-cache, no-transform');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(repository.listCommandEvents).toHaveBeenCalledWith(ids.user, ids.command, 1);
    expect(response.body).toContain('id: 2\nevent: assistant.delta\ndata: {"delta":"Answer"}\n\n');
    expect(response.body).toContain('id: 3\nevent: command.finished\ndata: {"outcome":"succeeded"}\n\n');
  });

  it('rejects malformed replay cursors and hides cross-user commands', async () => {
    const malformed = setup();
    expect((await malformed.app.inject({
      method: 'GET', url: `/api/commands/${ids.command}/events`, headers: { cookie, 'last-event-id': 'bad' },
    })).statusCode).toBe(400);
    const hidden = setup({ eventReads: [null] });
    expect((await hidden.app.inject({
      method: 'GET', url: `/api/commands/${ids.command}/events`, headers: { cookie },
    })).statusCode).toBe(404);
  });

  it('serves Conversation messages from the canonical stage-free URL', async () => {
    const { app, repository } = setup();
    const response = await app.inject({
      method: 'GET',
      url: `/api/conversations/${ids.thread}/messages`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      messages: [{ content: 'Persisted' }],
      pendingInterrupt: { id: 'interrupt-1', prompt: 'Approve?' },
    });
    expect(response.body).not.toContain('cursor');
    expect(repository.listConversationState).toHaveBeenCalledWith(ids.user, ids.thread);
  });

  it('accepts a zero-scope Start Command and schedules durable execution after 202', async () => {
    const { app, commandService } = setup();
    expect((await app.inject({
      method: 'POST',
      url: '/api/workflow/commands',
      headers: { cookie },
      payload: workflowCommandBody,
    })).statusCode).toBe(403);

    const response = await app.inject({
      method: 'POST',
      url: '/api/workflow/commands',
      headers: { cookie, origin },
      payload: workflowCommandBody,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      commandId: ids.command,
      eventUrl: `/api/commands/${ids.command}/events`,
    });
    expect(commandService.createCommand).toHaveBeenCalledWith(ids.user, workflowCommandBody);
    await vi.waitFor(() => expect(commandService.executeCommand).toHaveBeenCalledWith(ids.command));
  });

  it.each([
    ['message', { type: 'message', content: 'Question' }],
    ['named_intent', { type: 'named_intent', key: 'summarize' }],
    ['resume_interrupt', { type: 'resume_interrupt', interruptId: ids.interrupt, content: 'Approved' }],
  ])('accepts the public %s input without Stage fields', async (_label, input) => {
    const { app, commandService } = setup();
    const body = {
      commandId: ids.command,
      contextId: ids.context,
      routeId: ids.route,
      conversationId: ids.thread,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      input,
      attachmentIds: [],
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflow/commands',
      headers: { cookie, origin },
      payload: body,
    });
    expect(response.statusCode).toBe(202);
    expect(commandService.createCommand).toHaveBeenCalledWith(ids.user, body);
  });

  it('strictly rejects Stage ownership on the unified endpoint', async () => {
    const { app, commandService } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflow/commands',
      headers: { cookie, origin },
      payload: { ...workflowCommandBody, stageKey: 'discover' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'INVALID_REQUEST' } });
    expect(commandService.createCommand).not.toHaveBeenCalled();
  });

  it('retains the old Thread POST only as a compatibility adapter', async () => {
    const { app, commandService } = setup();
    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${ids.thread}/commands`,
      headers: { cookie, origin },
      payload: commandBody,
    });
    expect(response.statusCode).toBe(202);
    expect(commandService.createCommand).toHaveBeenCalledWith(ids.user, {
      commandId: ids.command,
      conversationId: ids.thread,
      baseCheckpointId: ids.checkpoint,
      expectedCheckpointVersion: 0,
      input: { type: 'message', content: 'Question' },
      attachmentIds: [],
    });
  });

  it('rate limits the unified mutation per authenticated user', async () => {
    const { app, commandService } = setup({ commandLimit: { max: 1, timeWindowMs: 60_000 } });
    const request = {
      method: 'POST' as const,
      url: '/api/workflow/commands',
      headers: { cookie, origin },
      payload: workflowCommandBody,
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    const limited = await app.inject({
      ...request,
      payload: { ...workflowCommandBody, commandId: '10000000-0000-4000-8000-000000000008' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: { code: 'RATE_LIMITED' } });
    expect(commandService.createCommand).toHaveBeenCalledTimes(1);
  });

  it('maps unexpected unified Command failures to the safe service error boundary', async () => {
    const { app } = setup({ createError: new Error('token=secret') });
    const response = await app.inject({
      method: 'POST',
      url: '/api/workflow/commands',
      headers: { cookie, origin },
      payload: workflowCommandBody,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: 'COMMAND_SERVICE_UNAVAILABLE' } });
    expect(response.body).not.toContain('secret');
  });
});
