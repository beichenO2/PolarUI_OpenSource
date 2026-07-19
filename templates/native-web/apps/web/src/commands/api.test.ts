import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandApiError,
  createCommand,
  createWorkflowCommand,
  listConversationMessages,
  streamCommandEvents,
  type PublicCommandInput,
  type WorkflowCommandEvent,
} from './api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function eventResponse(chunks: string[], status = 200) {
  const encoder = new TextEncoder();
  return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  }));
}

function frame(id: number, event: WorkflowCommandEvent['type'], payload: object, eol = '\n') {
  return `id: ${id}${eol}event: ${event}${eol}data: ${JSON.stringify(payload)}${eol}${eol}`;
}

const terminalFrame = (id: number, eol = '\n') => frame(id, 'command.finished', {
  outcome: 'succeeded',
  contextId: 'context-1',
  routeId: 'route-1',
  conversationId: 'conversation-1',
  checkpointId: null,
  stageProjectionRevision: 'projection-v2',
}, eol);

describe('workflow command web client', () => {
  it('reads persisted Conversation messages and a public pending interrupt', async () => {
    const body = {
      messages: [{
        id: 'message-1',
        commandId: 'command-1',
        role: 'assistant',
        content: '请补充目标用户。',
        sequence: 1,
        createdAt: '2026-07-16T00:00:00.000Z',
      }],
      pendingInterrupt: {
        id: 'interrupt-1',
        prompt: '目标用户是谁？',
        actionKey: 'adopt_thread',
        createdAt: '2026-07-16T00:01:00.000Z',
      },
    };
    const controller = new AbortController();
    const fetchMock = vi.fn(() => jsonResponse(body));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listConversationMessages('conversation id', { signal: controller.signal })).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/conversations/conversation%20id/messages', {
      credentials: 'same-origin',
      signal: controller.signal,
    });
  });

  it('posts the exact typed command payload and requires a 202 receipt', async () => {
    const input: PublicCommandInput = {
      commandId: '11111111-1111-4111-8111-111111111111',
      contextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      routeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      baseCheckpointId: '22222222-2222-4222-8222-222222222222',
      expectedCheckpointVersion: 3,
      input: { type: 'named_intent', key: 'summarize', content: '总结当前进展' },
      attachmentIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
    };
    const controller = new AbortController();
    const fetchMock = vi.fn(() => jsonResponse({
      commandId: input.commandId,
      eventUrl: `/api/commands/${input.commandId}/events`,
    }, 202));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createWorkflowCommand(input, { signal: controller.signal })).resolves.toEqual({
      commandId: input.commandId,
      eventUrl: `/api/commands/${input.commandId}/events`,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/workflow/commands', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  });

  it('rejects a successful command response that is not the contracted 202 receipt', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ commandId: 'command-1', eventUrl: '/events' })));

    await expect(createWorkflowCommand({
      commandId: 'command-1',
      input: { type: 'message', content: 'hello' },
      attachmentIds: [],
    })).rejects.toMatchObject({ code: 'COMMAND_RESPONSE_INVALID', status: 200 });
  });

  it.each(['workflow', 'deprecated'] as const)(
    'rejects a 202 %s receipt whose commandId differs from the submitted command',
    async (surface) => {
      const commandId = 'command-1';
      vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
        commandId: 'command-2',
        eventUrl: '/api/commands/command-2/events',
      }, 202)));

      const request = surface === 'workflow'
        ? createWorkflowCommand({
            commandId,
            input: { type: 'message', content: 'hello' },
            attachmentIds: [],
          })
        : createCommand('thread-1', {
            commandId,
            kind: 'message',
            content: 'hello',
            baseCheckpointId: 'checkpoint-1',
            expectedCheckpointVersion: 0,
          });

      await expect(request).rejects.toEqual(
        new CommandApiError('COMMAND_RESPONSE_INVALID', 202),
      );
    },
  );

  it.each([
    ['an absolute same-origin URL', 'http://localhost/api/commands/command-1/events'],
    ['an external URL', 'https://attacker.example/api/commands/command-1/events'],
    ['a different command', '/api/commands/command-2/events'],
    ['a different path', '/api/workflow/commands/command-1/events'],
    ['a query string', '/api/commands/command-1/events?after=0'],
  ])('rejects a 202 receipt with %s', async (_label, eventUrl) => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ commandId: 'command-1', eventUrl }, 202)));

    await expect(createWorkflowCommand({
      commandId: 'command-1',
      input: { type: 'message', content: 'hello' },
      attachmentIds: [],
    })).rejects.toEqual(new CommandApiError('COMMAND_RESPONSE_INVALID', 202));
  });

  it('parses a frame split across chunks and returns the terminal payload', async () => {
    const complete = [
      frame(1, 'command.accepted', { commandId: 'command-1' }),
      frame(2, 'workflow.started', {}),
      frame(3, 'assistant.delta', { delta: '研究' }),
      frame(4, 'workspace.committed', {
        contextId: 'context-1', routeId: 'route-1', conversationId: 'conversation-1', checkpointId: 'checkpoint-1',
      }),
      terminalFrame(5),
    ].join('');
    const splitAt = complete.indexOf('assistant.delta') + 9;
    vi.stubGlobal('fetch', vi.fn(() => eventResponse([
      complete.slice(0, splitAt),
      complete.slice(splitAt, splitAt + 7),
      complete.slice(splitAt + 7),
    ])));
    const events: WorkflowCommandEvent[] = [];

    const result = await streamCommandEvents('/api/commands/command-1/events', {}, (event) => {
      events.push(event);
    });

    expect(events.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: 1, type: 'command.accepted' },
      { id: 2, type: 'workflow.started' },
      { id: 3, type: 'assistant.delta' },
      { id: 4, type: 'workspace.committed' },
      { id: 5, type: 'command.finished' },
    ]);
    expect(result).toEqual({
      lastEventId: 5,
      finished: {
        outcome: 'succeeded',
        contextId: 'context-1',
        routeId: 'route-1',
        conversationId: 'conversation-1',
        checkpointId: null,
        stageProjectionRevision: 'projection-v2',
      },
    });
  });

  it('normalizes legacy persistence field names without exposing Thread or Stage state', async () => {
    vi.stubGlobal('fetch', vi.fn(() => eventResponse([
      frame(1, 'workspace.committed', {
        resultRouteId: 'route-legacy',
        resultThreadId: 'thread-legacy',
        resultCheckpointId: 'checkpoint-legacy',
      }) + frame(2, 'command.finished', {
        outcome: 'succeeded',
        resultRouteId: 'route-legacy',
        resultThreadId: 'thread-legacy',
        resultCheckpointId: 'checkpoint-legacy',
      }),
    ])));
    const events: WorkflowCommandEvent[] = [];

    const result = await streamCommandEvents('/events', {}, (event) => events.push(event));

    expect(events[0]?.payload).toEqual({
      routeId: 'route-legacy',
      conversationId: 'thread-legacy',
      checkpointId: 'checkpoint-legacy',
    });
    expect(result.finished).toEqual({
      outcome: 'succeeded',
      routeId: 'route-legacy',
      conversationId: 'thread-legacy',
      checkpointId: 'checkpoint-legacy',
    });
    expect(JSON.stringify(events)).not.toMatch(/resultThreadId|stageKey/);
  });

  it('rejects Stage-bearing terminal payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(() => eventResponse([
      frame(1, 'command.finished', { outcome: 'succeeded', stageKey: 'discover' }),
    ])));

    await expect(streamCommandEvents('/events', {}, () => undefined)).rejects.toEqual(
      new CommandApiError('COMMAND_STREAM_INVALID', 200),
    );
  });

  it('handles multiple CRLF frames in one chunk and ignores heartbeat comments', async () => {
    vi.stubGlobal('fetch', vi.fn(() => eventResponse([
      ': heartbeat\r\n\r\n' +
      frame(1, 'assistant.delta', { delta: 'A' }, '\r\n') +
      ': still-alive\r\n\r\n' +
      terminalFrame(2, '\r\n'),
    ])));
    const events: WorkflowCommandEvent[] = [];

    await streamCommandEvents('/events', {}, (event) => events.push(event));

    expect(events.map((event) => event.type)).toEqual(['assistant.delta', 'command.finished']);
  });

  it('sends Last-Event-ID and validates IDs monotonically from the reconnect point', async () => {
    const fetchMock = vi.fn(() => eventResponse([
      frame(8, 'assistant.delta', { delta: 'continued' }) + terminalFrame(9),
    ]));
    vi.stubGlobal('fetch', fetchMock);

    await streamCommandEvents('/events', { afterEventId: 7 }, () => undefined);

    expect(fetchMock).toHaveBeenCalledWith('/events', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'text/event-stream', 'Last-Event-ID': '7' },
      signal: undefined,
    });
  });

  it('maps structured JSON and conflict responses to CommandApiError', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => jsonResponse({ error: { code: 'CONVERSATION_NOT_FOUND' } }, 404))
      .mockImplementationOnce(() => jsonResponse({ error: { code: 'CHECKPOINT_VERSION_CONFLICT' } }, 409));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listConversationMessages('missing')).rejects.toEqual(
      new CommandApiError('CONVERSATION_NOT_FOUND', 404),
    );
    await expect(createWorkflowCommand({
      commandId: 'command-1',
      input: { type: 'named_intent', key: 'summarize' },
      attachmentIds: [],
    })).rejects.toEqual(new CommandApiError('CHECKPOINT_VERSION_CONFLICT', 409));
  });

  it('maps a structured event-stream request failure to CommandApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: { code: 'COMMAND_NOT_FOUND' } }, 404)));

    await expect(streamCommandEvents('/events', {}, () => undefined)).rejects.toEqual(
      new CommandApiError('COMMAND_NOT_FOUND', 404),
    );
  });

  it.each([
    ['unknown event', frame(1, 'unknown.event' as WorkflowCommandEvent['type'], {})],
    ['non-increasing event id', frame(2, 'assistant.delta', { delta: 'A' }) + terminalFrame(2)],
    ['invalid JSON', 'id: 1\nevent: assistant.delta\ndata: {oops}\n\n'],
    ['missing terminal event', frame(1, 'assistant.delta', { delta: 'A' })],
    ['final partial buffer', 'id: 1\nevent: assistant.delta\ndata: {"delta":"A"}'],
  ])('rejects malformed SSE: %s', async (_label, stream) => {
    vi.stubGlobal('fetch', vi.fn(() => eventResponse([stream])));

    await expect(streamCommandEvents('/events', {}, () => undefined)).rejects.toEqual(
      new CommandApiError('COMMAND_STREAM_INVALID', 200),
    );
  });

  it('propagates stream abortion without presenting it as a command error', async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame(1, 'command.accepted', { commandId: 'command-1' })));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))));
    const controller = new AbortController();
    const promise = streamCommandEvents('/events', { signal: controller.signal }, () => undefined);

    controller.abort(new DOMException('Stopped observing', 'AbortError'));

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });
});
