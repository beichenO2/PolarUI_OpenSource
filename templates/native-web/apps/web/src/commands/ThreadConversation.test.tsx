import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadConversation } from './ThreadConversation';
import * as commandApi from './api';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    listThreadMessages: vi.fn(),
    createCommand: vi.fn(),
    streamCommandEvents: vi.fn(),
  };
});

const thread = {
  id: '10000000-0000-4000-8000-000000000001', contextId: 'context', routeId: 'route',
  stageKey: 'discover', title: 'Evidence thread', status: 'active' as const,
  createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
};
const stage = {
  stageKey: 'discover', position: 0, status: 'active' as const, internalState: 'start',
  label: '发现', componentKey: 'generic_chat',
};
const checkpoint = {
  id: '10000000-0000-4000-8000-000000000002', contextId: 'context', routeId: 'route',
  parentCheckpointId: null, version: 0, stageKey: 'discover', reason: 'bootstrap' as const,
  snapshot: { stages: [] }, createdAt: '2026-07-16T00:00:00.000Z',
};
const actions = [
  { key: 'adopt_thread', label: '采纳到当前路线' },
  { key: 'advance', label: '推进阶段' },
];

function renderConversation(overrides: Partial<React.ComponentProps<typeof ThreadConversation>> = {}) {
  const onCommandFinished = vi.fn();
  const onConflict = vi.fn();
  const rendered = render(<ThreadConversation
    thread={thread}
    stage={stage}
    checkpoint={checkpoint}
    actions={actions}
    onCommandFinished={onCommandFinished}
    onConflict={onConflict}
    {...overrides}
  />);
  return { onCommandFinished, onConflict, ...rendered };
}

beforeEach(() => {
  vi.mocked(commandApi.listThreadMessages).mockReset().mockResolvedValue({
    messages: [
      { id: 'm1', commandId: 'c1', role: 'user', content: 'Question', sequence: 1, createdAt: checkpoint.createdAt },
      { id: 'm2', commandId: 'c1', role: 'assistant', content: 'Answer', sequence: 2, createdAt: checkpoint.createdAt },
    ],
    pendingInterrupt: null,
  });
  vi.mocked(commandApi.createCommand).mockReset().mockResolvedValue({ commandId: 'command-1', eventUrl: '/events/command-1' });
  vi.mocked(commandApi.streamCommandEvents).mockReset().mockImplementation(async (_url, _options, onEvent) => {
    onEvent({ id: 1, type: 'command.accepted', payload: {} });
    onEvent({ id: 2, type: 'assistant.delta', payload: { delta: 'Streamed answer' } });
    const finished = { outcome: 'succeeded' as const, resultRouteId: 'route', resultThreadId: thread.id };
    onEvent({ id: 3, type: 'command.finished', payload: finished });
    return { lastEventId: 3, finished };
  });
});

describe('ThreadConversation', () => {
  it('loads immutable messages and renders only the public pending interrupt', async () => {
    vi.mocked(commandApi.listThreadMessages).mockResolvedValueOnce({
      messages: [],
      pendingInterrupt: { id: 'interrupt-1', prompt: '请选择权威来源' },
    });
    renderConversation();
    expect(await screen.findByText('请选择权威来源')).toBeInTheDocument();
    expect(screen.queryByText(/cursor|secret/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('中断回复')).toBeInTheDocument();
    expect(screen.getByLabelText('发送消息')).toBeDisabled();
  });

  it('sends one message, renders the streamed reply, clears the draft, and reconciles', async () => {
    let finishStream!: () => void;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(async (_url, _options, onEvent) => {
      onEvent({ id: 1, type: 'assistant.delta', payload: { delta: 'Streamed answer' } });
      await new Promise<void>((resolve) => { finishStream = resolve; });
      const finished = { outcome: 'succeeded' as const, resultRouteId: 'route', resultThreadId: thread.id };
      onEvent({ id: 2, type: 'command.finished', payload: finished });
      return { lastEventId: 2, finished };
    });
    const { onCommandFinished } = renderConversation();
    await screen.findByText('Answer');
    await userEvent.type(screen.getByLabelText('消息内容'), 'New question');
    await userEvent.click(screen.getByLabelText('发送消息'));
    expect(await screen.findByText('Streamed answer')).toBeInTheDocument();
    await act(async () => finishStream());
    await waitFor(() => expect(commandApi.createCommand).toHaveBeenCalledWith(thread.id, expect.objectContaining({
      kind: 'message', content: 'New question', baseCheckpointId: checkpoint.id, expectedCheckpointVersion: 0,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(screen.getByLabelText('消息内容')).toHaveValue('');
    expect(commandApi.listThreadMessages).toHaveBeenCalledTimes(2);
    expect(onCommandFinished).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'succeeded' }));
  });

  it('prevents double submit and retains the draft after a failed command', async () => {
    let resolveStream!: (value: { lastEventId: number; finished: commandApi.CommandFinishedPayload }) => void;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(() => new Promise((resolve) => { resolveStream = resolve; }));
    renderConversation();
    await screen.findByText('Answer');
    await userEvent.type(screen.getByLabelText('消息内容'), 'Keep this');
    const send = screen.getByLabelText('发送消息');
    await userEvent.click(send);
    expect(send).toBeDisabled();
    await userEvent.click(send);
    expect(commandApi.createCommand).toHaveBeenCalledTimes(1);
    await act(async () => resolveStream({ lastEventId: 1, finished: { outcome: 'failed', code: 'WORKFLOW_TIMEOUT' } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('WORKFLOW_TIMEOUT');
    expect(screen.getByLabelText('消息内容')).toHaveValue('Keep this');
  });

  it('renders manifest actions and disables them for a not-started stage', async () => {
    renderConversation({ stage: { ...stage, status: 'not_started' } });
    await screen.findByText('Answer');
    expect(screen.getByRole('button', { name: '采纳到当前路线' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '推进阶段' })).toBeDisabled();
  });

  it('submits manifest actions with stable non-empty command content', async () => {
    renderConversation();
    await screen.findByText('Answer');
    await userEvent.click(screen.getByRole('button', { name: '采纳到当前路线' }));
    expect(commandApi.createCommand).toHaveBeenCalledWith(thread.id, expect.objectContaining({
      kind: 'named_action', actionKey: 'adopt_thread', content: '采纳到当前路线',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('submits a resume with the public interrupt id and never a private cursor', async () => {
    vi.mocked(commandApi.listThreadMessages)
      .mockResolvedValueOnce({ messages: [], pendingInterrupt: { id: 'interrupt-1', prompt: 'Approve?' } })
      .mockResolvedValue({ messages: [], pendingInterrupt: null });
    renderConversation();
    await userEvent.type(await screen.findByLabelText('中断回复'), 'Approved');
    await userEvent.click(screen.getByRole('button', { name: '继续工作流' }));
    expect(commandApi.createCommand).toHaveBeenCalledWith(thread.id, expect.objectContaining({
      kind: 'resume_interrupt', interruptId: 'interrupt-1', content: 'Approved',
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(vi.mocked(commandApi.createCommand).mock.calls)).not.toContain('cursor');
  });

  it('reconnects from the last observed event id when a stream drops', async () => {
    vi.mocked(commandApi.streamCommandEvents)
      .mockImplementationOnce(async (_url, _options, onEvent) => {
        onEvent({ id: 4, type: 'assistant.delta', payload: { delta: 'Partial' } });
        throw new commandApi.CommandApiError('COMMAND_STREAM_INVALID', 200);
      })
      .mockImplementationOnce(async (_url, options, onEvent) => {
        expect(options.afterEventId).toBe(4);
        const finished = { outcome: 'succeeded' as const };
        onEvent({ id: 5, type: 'command.finished', payload: finished });
        return { lastEventId: 5, finished };
      });
    renderConversation();
    await screen.findByText('Answer');
    await userEvent.type(screen.getByLabelText('消息内容'), 'Reconnect');
    await userEvent.click(screen.getByLabelText('发送消息'));
    await waitFor(() => expect(commandApi.streamCommandEvents).toHaveBeenCalledTimes(2));
  });

  it('reconnects after a real transport failure', async () => {
    vi.mocked(commandApi.streamCommandEvents)
      .mockImplementationOnce(async (_url, _options, onEvent) => {
        onEvent({ id: 4, type: 'assistant.delta', payload: { delta: 'Partial' } });
        throw new TypeError('network connection lost');
      })
      .mockImplementationOnce(async (_url, options, onEvent) => {
        expect(options.afterEventId).toBe(4);
        const finished = { outcome: 'succeeded' as const };
        onEvent({ id: 5, type: 'command.finished', payload: finished });
        return { lastEventId: 5, finished };
      });
    renderConversation();
    await screen.findByText('Answer');
    await userEvent.type(screen.getByLabelText('消息内容'), 'Reconnect transport');
    await userEvent.click(screen.getByLabelText('发送消息'));
    await waitFor(() => expect(commandApi.streamCommandEvents).toHaveBeenCalledTimes(2));
  });

  it('stops observing a durable command when the conversation unmounts', async () => {
    let streamSignal: AbortSignal | undefined;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(async (_url, options) => {
      streamSignal = options.signal;
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
      throw new Error('unreachable');
    });
    const rendered = renderConversation();
    await screen.findByText('Answer');
    await userEvent.type(screen.getByLabelText('消息内容'), 'Navigate away');
    await userEvent.click(screen.getByLabelText('发送消息'));
    await waitFor(() => expect(streamSignal).toBeDefined());
    rendered.unmount();
    expect(streamSignal?.aborted).toBe(true);
  });
});
