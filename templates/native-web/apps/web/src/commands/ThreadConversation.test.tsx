import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense, startTransition, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StagedAttachment } from '../assets/api';
import * as assetApi from '../assets/api';
import type { WorkflowCheckpoint, WorkflowConversation } from '../domain/api';
import type { WorkspaceSelection } from '../workspace/useWorkflowWorkspace';
import { ConversationPane } from './ThreadConversation';
import * as commandApi from './api';

const attachmentHarness = vi.hoisted(() => ({
  useRealPanel: false,
  changes: new Map<string, (
    ownerKey: string,
    update: (current: StagedAttachment[]) => StagedAttachment[],
  ) => void>(),
}));

vi.mock('../assets/api', async () => {
  const actual = await vi.importActual<typeof import('../assets/api')>('../assets/api');
  return {
    ...actual,
    stageAttachment: vi.fn(),
    deleteStagedAttachment: vi.fn(),
    listConversationAttachments: vi.fn(),
  };
});

vi.mock('../assets/AttachmentPanel', async () => {
  const actual = await vi.importActual<typeof import('../assets/AttachmentPanel')>('../assets/AttachmentPanel');
  const ActualAttachmentPanel = actual.AttachmentPanel;
  return { ...actual, AttachmentPanel: (props: {
    staged: StagedAttachment[];
    onChange: (ownerKey: string, update: (current: StagedAttachment[]) => StagedAttachment[]) => void;
    conversationId?: string;
    draftKey?: string;
  }) => {
    if (attachmentHarness.useRealPanel) return <ActualAttachmentPanel {...props} />;
    const {
      staged,
      onChange,
      conversationId,
      draftKey,
    } = props;
    const ownerKey = conversationId ? `conversation:${conversationId}` : `draft:${draftKey ?? 'default'}`;
    attachmentHarness.changes.set(ownerKey, onChange);
    return <div>
      {staged.map((attachment) => <span key={attachment.id}>{attachment.filename}</span>)}
    </div>;
  } };
});

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    listConversationMessages: vi.fn(),
    createWorkflowCommand: vi.fn(),
    streamCommandEvents: vi.fn(),
  };
});

const selection: WorkspaceSelection = {
  contextId: 'context-a', routeId: 'route-a', conversationId: 'conversation-a', checkpointId: 'checkpoint-head',
};
const conversation: WorkflowConversation = {
  id: 'conversation-a', contextId: 'context-a', routeId: 'route-a', title: 'Evidence review',
  titleSource: 'agent', isPrimary: true, status: 'active',
  createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
};
const checkpoint: WorkflowCheckpoint = {
  id: 'checkpoint-head', contextId: 'context-a', routeId: 'route-a', parentCheckpointId: null,
  version: 3, stageKey: null, reason: 'workflow_action',
  snapshot: { workflowState: {}, memoryReferences: [], artifacts: [] },
  createdAt: '2026-07-17T00:00:00.000Z',
};
const stagedAttachments: StagedAttachment[] = [{
  id: 'attachment-a', filename: 'evidence.pdf', mediaType: 'application/pdf', byteSize: 12,
  sha256: 'a'.repeat(64), status: 'pending', conversationId: null,
  createdAt: '2026-07-17T00:00:00.000Z',
}];
const intents = [{ key: 'summarize', label: '生成摘要' }];

function renderPane(options: {
  selection?: WorkspaceSelection;
  conversation?: WorkflowConversation;
  checkpoint?: WorkflowCheckpoint;
  initialDraft?: string;
  attachments?: StagedAttachment[];
  isHistorical?: boolean;
} = {}) {
  const onCommandFinished = vi.fn();
  const onAttachmentIdsChange = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState(options.initialDraft ?? '');
    return <ConversationPane
      ownerIdentity="demo:user-1"
      selection={options.selection ?? selection}
      conversation={options.conversation === undefined && options.selection === undefined
        ? conversation
        : options.conversation}
      checkpoint={options.checkpoint === undefined && options.selection === undefined
        ? checkpoint
        : options.checkpoint}
      intents={intents}
      stagedAttachments={options.attachments ?? []}
      draft={draft}
      onDraftChange={setDraft}
      onAttachmentIdsChange={onAttachmentIdsChange}
      isHistorical={options.isHistorical}
      onCommandFinished={onCommandFinished}
    />;
  }
  return { ...render(<Harness />), onCommandFinished, onAttachmentIdsChange };
}

beforeEach(() => {
  attachmentHarness.useRealPanel = false;
  attachmentHarness.changes.clear();
  vi.mocked(assetApi.stageAttachment).mockReset().mockResolvedValue(stagedAttachments[0]!);
  vi.mocked(assetApi.deleteStagedAttachment).mockReset().mockResolvedValue(undefined);
  vi.mocked(assetApi.listConversationAttachments).mockReset().mockResolvedValue([]);
  vi.mocked(commandApi.listConversationMessages).mockReset().mockResolvedValue({
    messages: [
      { id: 'm1', commandId: 'c1', role: 'user', content: 'Question', sequence: 1, createdAt: checkpoint.createdAt },
      { id: 'm2', commandId: 'c1', role: 'assistant', content: 'Answer', sequence: 2, createdAt: checkpoint.createdAt },
    ],
    pendingInterrupt: null,
  });
  vi.mocked(commandApi.createWorkflowCommand).mockReset().mockImplementation(async (input) => ({
    commandId: input.commandId,
    eventUrl: `/api/commands/${input.commandId}/events`,
  }));
  vi.mocked(commandApi.streamCommandEvents).mockReset().mockResolvedValue({
    lastEventId: 1,
    finished: { outcome: 'succeeded', contextId: 'context-a', routeId: 'route-a', conversationId: 'conversation-a', checkpointId: 'checkpoint-next' },
  });
});

describe('ConversationPane permanent composer', () => {
  it.each([
    ['empty', { virtualConversationId: 'virtual:start' } as WorkspaceSelection, undefined, undefined],
    ['virtual', { contextId: 'context-a', routeId: 'route-a', virtualConversationId: 'virtual:new:one' } as WorkspaceSelection, undefined, checkpoint],
    ['current', selection, conversation, checkpoint],
    ['history', { ...selection, checkpointId: 'checkpoint-old' }, conversation, { ...checkpoint, id: 'checkpoint-old' }],
  ])('keeps Workflow Input enabled in %s mode', async (_mode, selected, selectedConversation, selectedCheckpoint) => {
    renderPane({ selection: selected, conversation: selectedConversation, checkpoint: selectedCheckpoint });
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toBeEnabled();
  });

  it('loads only the selected real Conversation and renders its immutable local history', async () => {
    renderPane();
    expect(await screen.findByText('Answer')).toBeInTheDocument();
    expect(screen.getByRole('log', { name: 'Conversation 消息' })).toHaveAttribute('aria-live', 'polite');
    expect(commandApi.listConversationMessages).toHaveBeenCalledWith('conversation-a', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it('announces execution and completion from one atomic status live region', async () => {
    let finish!: () => void;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(async (_url, _options, onEvent) => {
      onEvent({ id: 1, type: 'command.accepted', payload: {} });
      onEvent({ id: 2, type: 'workflow.started', payload: {} });
      await new Promise<void>((resolve) => { finish = resolve; });
      return { lastEventId: 3, finished: { outcome: 'succeeded' as const } };
    });
    renderPane({ initialDraft: '验证 live region' });

    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('Workflow 正在执行');

    await act(async () => finish());
    await waitFor(() => expect(status).toHaveTextContent('已完成'));
  });

  it('announces a failed Command next to its triggering Input', async () => {
    vi.mocked(commandApi.streamCommandEvents).mockResolvedValueOnce({
      lastEventId: 1,
      finished: { outcome: 'failed', code: 'WORKFLOW_UNAVAILABLE' },
    });
    renderPane({ initialDraft: '验证错误播报' });

    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('WORKFLOW_UNAVAILABLE');
    expect(screen.getByRole('textbox', { name: 'Workflow Input' }).closest('form'))
      .toContainElement(alert);
    expect(screen.getByRole('status')).toHaveTextContent('执行失败');
  });

  it('renders selected Checkpoint artifacts as read-only Workflow results in the causal timeline', async () => {
    const selectedCheckpoint: WorkflowCheckpoint = {
      ...checkpoint,
      snapshot: {
        ...checkpoint.snapshot,
        artifacts: [{
          id: 'artifact/selected',
          stage_key: null,
          filename: 'selected-report.pdf',
          media_type: 'application/pdf',
          byte_size: 2048,
          sha256: 'b'.repeat(64),
          created_at: '2026-07-18T00:00:00.000Z',
        }],
      },
    };
    renderPane({ checkpoint: selectedCheckpoint });

    const link = await screen.findByRole('link', { name: /selected-report\.pdf/ });
    expect(link.closest('.message-timeline')).not.toBeNull();
    expect(link).toHaveAttribute('href', '/api/assets/artifact/artifact%2Fselected/download');
    expect(link).toHaveTextContent('Workflow 成果');
    expect(link).toHaveTextContent('Checkpoint 03');
  });

  it('starts with zero Context, announces initialization and streams live execution feedback', async () => {
    let finish!: () => void;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(async (_url, _options, onEvent) => {
      onEvent({ id: 1, type: 'command.accepted', payload: {} });
      onEvent({ id: 2, type: 'workflow.started', payload: {} });
      onEvent({ id: 3, type: 'assistant.delta', payload: { delta: '正在分析' } });
      await new Promise<void>((resolve) => { finish = resolve; });
      const finished = { outcome: 'succeeded' as const, contextId: 'context-new', routeId: 'route-new', conversationId: 'conversation-new', checkpointId: 'checkpoint-new' };
      onEvent({ id: 4, type: 'command.finished', payload: finished });
      return { lastEventId: 4, finished };
    });
    const { onCommandFinished } = renderPane({
      selection: { virtualConversationId: 'virtual:start' }, conversation: undefined, checkpoint: undefined,
    });

    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), '帮我梳理发布计划');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(screen.getByRole('status')).toHaveTextContent('正在理解并建立工作情景');
    expect(await screen.findByText('正在分析')).toBeInTheDocument();
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      contextId: undefined,
      routeId: undefined,
      conversationId: undefined,
      input: { type: 'message', content: '帮我梳理发布计划' },
      attachmentIds: [],
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await act(async () => finish());
    await waitFor(() => expect(onCommandFinished).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded' }),
      expect.objectContaining({ draft: '', attachmentIds: [] }),
    ));
  });

  it('retains the exact failed Input and attachment IDs and retries as a new stable Command attempt', async () => {
    vi.mocked(commandApi.streamCommandEvents)
      .mockResolvedValueOnce({ lastEventId: 1, finished: { outcome: 'failed', code: 'WORKFLOW_UNAVAILABLE' } })
      .mockResolvedValueOnce({ lastEventId: 1, finished: { outcome: 'succeeded', checkpointId: 'checkpoint-next' } });
    renderPane({ initialDraft: '  保留这段原文  ', attachments: stagedAttachments });

    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('WORKFLOW_UNAVAILABLE');
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('  保留这段原文  ');
    expect(screen.getByText('evidence.pdf')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Workflow Input' }).closest('form')).toContainElement(alert);

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(commandApi.createWorkflowCommand).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(commandApi.createWorkflowCommand).mock.calls.map(([input]) => input);
    expect(first.attachmentIds).toEqual(['attachment-a']);
    expect(first.input).toEqual({ type: 'message', content: '  保留这段原文  ' });
    expect(second.attachmentIds).toEqual(first.attachmentIds);
    expect(second.input).toEqual(first.input);
    expect(second.commandId).not.toBe(first.commandId);
    expect(first.commandId).toBeTruthy();
    expect(second.commandId).toBeTruthy();
  });

  it('preserves a newer draft typed while an earlier Command succeeds', async () => {
    let finish!: () => void;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { lastEventId: 1, finished: { outcome: 'succeeded' as const } };
    });
    renderPane({ initialDraft: 'attempt A' });
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    const input = screen.getByRole('textbox', { name: 'Workflow Input' });
    await userEvent.clear(input);
    await userEvent.type(input, 'next draft B');

    await act(async () => finish());
    expect(input).toHaveValue('next draft B');
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commandApi.createWorkflowCommand).mock.calls[0]![0].input).toEqual({
      type: 'message', content: 'attempt A',
    });
  });

  it('removes only the successful attempt attachments and keeps a later real upload', async () => {
    attachmentHarness.useRealPanel = true;
    const attachmentB: StagedAttachment = {
      ...stagedAttachments[0]!, id: 'attachment-b', filename: 'next.pdf', sha256: 'b'.repeat(64),
    };
    vi.mocked(assetApi.stageAttachment).mockResolvedValueOnce(attachmentB);
    vi.mocked(commandApi.streamCommandEvents)
      .mockResolvedValueOnce({ lastEventId: 1, finished: { outcome: 'failed', code: 'WORKFLOW_UNAVAILABLE' } })
      .mockResolvedValueOnce({ lastEventId: 1, finished: { outcome: 'succeeded' } });
    const { onAttachmentIdsChange } = renderPane({
      initialDraft: 'attempt A', attachments: stagedAttachments,
    });
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await screen.findByRole('alert');
    await userEvent.upload(screen.getByLabelText('添加附件'), new File(['next'], 'next.pdf', {
      type: 'application/pdf',
    }));
    expect(await screen.findByText('next.pdf')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(commandApi.createWorkflowCommand).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('evidence.pdf')).not.toBeInTheDocument());
    expect(screen.getByText('next.pdf')).toBeInTheDocument();
    expect(onAttachmentIdsChange).toHaveBeenLastCalledWith(['attachment-b']);
    expect(vi.mocked(commandApi.createWorkflowCommand).mock.calls[1]![0].attachmentIds).toEqual(['attachment-a']);
  });

  it('keeps a successful terminal final when the post-success message reload fails', async () => {
    vi.mocked(commandApi.listConversationMessages)
      .mockResolvedValueOnce({ messages: [], pendingInterrupt: null })
      .mockRejectedValueOnce(new TypeError('message sync failed'));
    const { onCommandFinished } = renderPane({ initialDraft: 'successful command' });
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(onCommandFinished).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded' }),
      expect.objectContaining({ draft: '', attachmentIds: [] }),
    ));

    expect(commandApi.createWorkflowCommand).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '重新载入消息' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('已完成');
  });

  it('recovers an initial owner-scoped message load failure without creating a Command retry', async () => {
    vi.mocked(commandApi.listConversationMessages)
      .mockRejectedValueOnce(new TypeError('initial message load failed'))
      .mockResolvedValueOnce({
        messages: [{
          id: 'recovered-message', commandId: 'old-command', role: 'assistant',
          content: 'Recovered history', sequence: 1, createdAt: checkpoint.createdAt,
        }],
        pendingInterrupt: null,
      });
    renderPane();
    expect(await screen.findByRole('button', { name: '重新载入消息' })).toBeInTheDocument();
    expect(screen.getByRole('status')).not.toHaveTextContent('正在载入 Conversation');
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '重新载入消息' }));
    expect(await screen.findByText('Recovered history')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新载入消息' })).not.toBeInTheDocument();
    expect(commandApi.createWorkflowCommand).not.toHaveBeenCalled();
  });

  it('lets a Command take over an initial message load without leaving loading stuck or accepting stale history', async () => {
    let releaseInitial!: (value: Awaited<ReturnType<typeof commandApi.listConversationMessages>>) => void;
    vi.mocked(commandApi.listConversationMessages)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseInitial = resolve; }))
      .mockResolvedValueOnce({ messages: [], pendingInterrupt: null });
    renderPane({ initialDraft: 'run while history loads' });
    await waitFor(() => expect(commandApi.listConversationMessages).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已完成'));
    expect(screen.getByRole('region', { name: 'Evidence review' })).toHaveAttribute('aria-busy', 'false');

    await act(async () => releaseInitial({
      messages: [{
        id: 'stale-initial', commandId: 'stale-command', role: 'assistant',
        content: 'Stale initial history', sequence: 1, createdAt: checkpoint.createdAt,
      }],
      pendingInterrupt: null,
    }));
    expect(screen.queryByText('Stale initial history')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('已完成');
  });

  it('lets a Command take over a retry message load without a late retry overwriting terminal state', async () => {
    let releaseRetry!: (value: Awaited<ReturnType<typeof commandApi.listConversationMessages>>) => void;
    vi.mocked(commandApi.listConversationMessages)
      .mockRejectedValueOnce(new TypeError('initial message load failed'))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseRetry = resolve; }))
      .mockResolvedValueOnce({ messages: [], pendingInterrupt: null });
    renderPane({ initialDraft: 'run during retry' });
    await screen.findByRole('button', { name: '重新载入消息' });
    await userEvent.click(screen.getByRole('button', { name: '重新载入消息' }));
    await waitFor(() => expect(commandApi.listConversationMessages).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已完成'));
    expect(screen.getByRole('region', { name: 'Evidence review' })).toHaveAttribute('aria-busy', 'false');

    await act(async () => releaseRetry({
      messages: [{
        id: 'stale-retry', commandId: 'stale-command', role: 'assistant',
        content: 'Stale retry history', sequence: 1, createdAt: checkpoint.createdAt,
      }],
      pendingInterrupt: null,
    }));
    expect(screen.queryByText('Stale retry history')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('已完成');
  });

  it('uses the selected historical Checkpoint and shows the exact immutable-history warning', async () => {
    const historicalCheckpoint = { ...checkpoint, id: 'checkpoint-old', version: 1 };
    renderPane({
      selection: { ...selection, checkpointId: historicalCheckpoint.id },
      conversation,
      checkpoint: historicalCheckpoint,
      initialDraft: '从这里继续',
      isHistorical: true,
    });

    expect(screen.getByRole('note')).toHaveTextContent(
      '正在查看历史投影。此版本不可修改；从这里输入会创建一条新时间线，原路线不受影响。',
    );
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      baseCheckpointId: 'checkpoint-old',
      expectedCheckpointVersion: 1,
    }), expect.anything());
  });

  it('renders named intents as secondary shortcuts and never emits Stage controls', async () => {
    renderPane();
    await screen.findByText('Answer');
    await userEvent.click(screen.getByRole('button', { name: '生成摘要' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      input: { type: 'named_intent', key: 'summarize' },
    }), expect.anything());
    const payload = JSON.stringify(vi.mocked(commandApi.createWorkflowCommand).mock.calls[0]![0]);
    expect(payload).not.toMatch(/stageKey|stage_key|setStage/);
    expect(screen.queryByRole('navigation', { name: /Stage|阶段/ })).not.toBeInTheDocument();
  });

  it('renders a public interrupt inline and resumes with no private cursor', async () => {
    vi.mocked(commandApi.listConversationMessages).mockResolvedValueOnce({
      messages: [], pendingInterrupt: { id: 'interrupt-a', prompt: '请选择权威来源' },
    });
    renderPane();
    const interruptForm = await screen.findByRole('form', { name: 'Workflow Interrupt' });
    expect(within(interruptForm).getByText('请选择权威来源', { exact: true })).toBeInTheDocument();
    await userEvent.type(within(interruptForm).getByRole('textbox', { name: 'Interrupt 回复' }), '使用官网');
    await userEvent.click(within(interruptForm).getByRole('button', { name: '继续 Workflow' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      input: { type: 'resume_interrupt', interruptId: 'interrupt-a', content: '使用官网' },
    }), expect.anything());
    expect(JSON.stringify(vi.mocked(commandApi.createWorkflowCommand).mock.calls)).not.toContain('cursor');
  });

  it('renders a failed Interrupt resume error and retry inside the Interrupt form only', async () => {
    vi.mocked(commandApi.listConversationMessages).mockResolvedValueOnce({
      messages: [], pendingInterrupt: { id: 'interrupt-a', prompt: '请选择权威来源' },
    });
    vi.mocked(commandApi.streamCommandEvents).mockResolvedValueOnce({
      lastEventId: 1,
      finished: { outcome: 'failed', code: 'WORKFLOW_UNAVAILABLE' },
    });
    renderPane();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Interrupt 回复' }), '使用官网');
    await userEvent.click(screen.getByRole('button', { name: '继续 Workflow' }));

    const alert = await screen.findByRole('alert');
    expect(alert.closest('form')).toHaveClass('interrupt-panel');
    expect(screen.getByRole('textbox', { name: 'Workflow Input' }).closest('form'))
      .not.toContainElement(alert);
    expect(within(alert).getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('reconnects a durable attempt from the last event with the same receipt', async () => {
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
    renderPane({ initialDraft: 'Reconnect' });
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(commandApi.streamCommandEvents).toHaveBeenCalledTimes(2));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledTimes(1);
    const commandId = vi.mocked(commandApi.createWorkflowCommand).mock.calls[0]![0].commandId;
    expect(vi.mocked(commandApi.streamCommandEvents).mock.calls[0]![0]).toContain(commandId);
    expect(vi.mocked(commandApi.streamCommandEvents).mock.calls[1]![0]).toContain(commandId);
  });

  it('keeps an old-owner upload away from the new owner and restores it when returning', async () => {
    const onAttachmentIdsChange = vi.fn();
    function OwnerHarness() {
      const [useVirtual, setUseVirtual] = useState(false);
      return <>
        <button type="button" onClick={() => setUseVirtual((current) => !current)}>切换 owner</button>
        <ConversationPane
          ownerIdentity="demo:user-1"
          selection={useVirtual
            ? { contextId: 'context-a', routeId: 'route-a', virtualConversationId: 'virtual:new:two', checkpointId: checkpoint.id }
            : selection}
          conversation={useVirtual ? undefined : conversation}
          checkpoint={checkpoint}
          intents={[]}
          stagedAttachments={[]}
          draft=""
          onDraftChange={vi.fn()}
          onAttachmentIdsChange={onAttachmentIdsChange}
          onCommandFinished={vi.fn()}
        />
      </>;
    }
    render(<OwnerHarness />);
    await screen.findByText('Answer');
    const oldOwnerChange = attachmentHarness.changes.get('conversation:conversation-a')!;

    await userEvent.click(screen.getByRole('button', { name: '切换 owner' }));
    await act(async () => {
      oldOwnerChange('conversation:conversation-a', () => stagedAttachments);
    });
    expect(onAttachmentIdsChange).not.toHaveBeenCalledWith(['attachment-a']);

    await userEvent.click(screen.getByRole('button', { name: '切换 owner' }));
    await waitFor(() => expect(onAttachmentIdsChange).toHaveBeenCalledWith(['attachment-a']));
  });

  it('aborts an in-flight attempt when its virtual owner changes and enables the new owner', async () => {
    let streamSignal: AbortSignal | undefined;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(async (_url, options) => {
      streamSignal = options.signal;
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
      throw new Error('unreachable');
    });
    const onCommandFinished = vi.fn();
    function VirtualOwnerHarness() {
      const [owner, setOwner] = useState('virtual:new:a');
      const [draft, setDraft] = useState('owner a');
      return <>
        <button type="button" onClick={() => {
          setOwner('virtual:new:b');
          setDraft('owner b');
        }}>切换 virtual owner</button>
        <ConversationPane
          ownerIdentity="demo:user-1"
          selection={{ contextId: 'context-a', routeId: 'route-a', virtualConversationId: owner, checkpointId: checkpoint.id }}
          checkpoint={checkpoint}
          intents={[]}
          stagedAttachments={[]}
          draft={draft}
          onDraftChange={setDraft}
          onCommandFinished={onCommandFinished}
        />
      </>;
    }
    render(<VirtualOwnerHarness />);
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(streamSignal).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: '切换 virtual owner' }));
    await waitFor(() => expect(streamSignal?.aborted).toBe(true));
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('owner b');
    expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeEnabled();
    expect(onCommandFinished).not.toHaveBeenCalled();
  });

  it('namespaces staged attachments by product/user identity during an async upload', async () => {
    vi.mocked(commandApi.streamCommandEvents).mockResolvedValueOnce({
      lastEventId: 1,
      finished: { outcome: 'failed', code: 'WORKFLOW_UNAVAILABLE' },
    });
    function IdentityHarness() {
      const [ownerIdentity, setOwnerIdentity] = useState('demo:user-a');
      const [draft, setDraft] = useState('owner b input');
      return <>
        <button type="button" onClick={() => setOwnerIdentity((current) => (
          current === 'demo:user-a' ? 'demo:user-b' : 'demo:user-a'
        ))}>切换 identity</button>
        <ConversationPane
          ownerIdentity={ownerIdentity}
          selection={selection}
          conversation={conversation}
          checkpoint={checkpoint}
          intents={[]}
          stagedAttachments={[]}
          draft={draft}
          onDraftChange={setDraft}
          onCommandFinished={vi.fn()}
        />
      </>;
    }
    render(<IdentityHarness />);
    await screen.findByText('Answer');
    const ownerAUpload = attachmentHarness.changes.get('conversation:conversation-a')!;

    await userEvent.click(screen.getByRole('button', { name: '切换 identity' }));
    await act(async () => ownerAUpload('conversation:conversation-a', () => stagedAttachments));
    expect(screen.queryByText('evidence.pdf')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIds: [],
    }), expect.anything());

    await userEvent.click(screen.getByRole('button', { name: '切换 identity' }));
    expect(await screen.findByText('evidence.pdf')).toBeInTheDocument();
  });

  it('keeps a deferred real AttachmentPanel upload with the identity that started it', async () => {
    attachmentHarness.useRealPanel = true;
    let releaseUpload!: (attachment: StagedAttachment) => void;
    vi.mocked(assetApi.stageAttachment).mockImplementationOnce(() => new Promise((resolve) => {
      releaseUpload = resolve;
    }));
    function RealIdentityHarness() {
      const [ownerIdentity, setOwnerIdentity] = useState('demo:user-a');
      return <>
        <button type="button" onClick={() => setOwnerIdentity((current) => (
          current === 'demo:user-a' ? 'demo:user-b' : 'demo:user-a'
        ))}>切换 real identity</button>
        <ConversationPane
          ownerIdentity={ownerIdentity}
          selection={selection}
          conversation={conversation}
          checkpoint={checkpoint}
          intents={[]}
          stagedAttachments={[]}
          draft=""
          onDraftChange={vi.fn()}
          onCommandFinished={vi.fn()}
        />
      </>;
    }
    render(<RealIdentityHarness />);
    await screen.findByText('Answer');
    await userEvent.upload(screen.getByLabelText('添加附件'), new File(['evidence'], 'evidence.pdf', {
      type: 'application/pdf',
    }));
    await waitFor(() => expect(assetApi.stageAttachment).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: '切换 real identity' }));
    await act(async () => releaseUpload(stagedAttachments[0]!));
    expect(screen.queryByText('evidence.pdf')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '切换 real identity' }));
    expect(await screen.findByText('evidence.pdf')).toBeInTheDocument();
  });

  it('does not hand a committed bootstrap upload to an owner from an abandoned render', async () => {
    attachmentHarness.useRealPanel = true;
    let releaseUpload!: (attachment: StagedAttachment) => void;
    vi.mocked(assetApi.stageAttachment).mockImplementationOnce(() => new Promise((resolve) => {
      releaseUpload = resolve;
    }));
    const abandoned = new Promise<void>(() => undefined);
    let renderedAbandonedOwner = false;

    function SuspendAfterPane({ suspend }: { suspend: boolean }) {
      if (suspend) {
        renderedAbandonedOwner = true;
        throw abandoned;
      }
      return null;
    }

    function ConcurrentUploadHarness() {
      const [showGhostOwner, setShowGhostOwner] = useState(false);
      const selected: WorkspaceSelection = showGhostOwner
        ? selection
        : {};
      return <>
        <button type="button" onClick={() => {
          startTransition(() => setShowGhostOwner(true));
        }}>尝试切换到 ghost owner</button>
        <Suspense fallback={<p>ghost fallback</p>}>
          <ConversationPane
            ownerIdentity="demo:user-1"
            selection={selected}
            conversation={showGhostOwner ? conversation : undefined}
            checkpoint={showGhostOwner ? checkpoint : undefined}
            intents={[]}
            stagedAttachments={[]}
            draft=""
            onDraftChange={vi.fn()}
            onAttachmentIdsChange={vi.fn()}
            scopeReady={showGhostOwner}
            onCommandFinished={vi.fn()}
          />
          <SuspendAfterPane suspend={showGhostOwner} />
        </Suspense>
      </>;
    }

    render(<ConcurrentUploadHarness />);
    expect(await screen.findByRole('heading', { name: '未命名 Conversation' })).toBeInTheDocument();
    await userEvent.upload(
      screen.getByLabelText('添加附件'),
      new File(['evidence'], 'evidence.pdf', { type: 'application/pdf' }),
    );
    await waitFor(() => expect(assetApi.stageAttachment).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole('button', { name: '尝试切换到 ghost owner' }));
    await waitFor(() => expect(renderedAbandonedOwner).toBe(true));
    expect(screen.getByRole('heading', { name: '未命名 Conversation' })).toBeInTheDocument();
    expect(screen.queryByText('ghost fallback')).not.toBeInTheDocument();

    await act(async () => releaseUpload(stagedAttachments[0]!));

    expect(await screen.findByText('evidence.pdf')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '未命名 Conversation' })).toBeInTheDocument();
  });

  it('publishes only committed draft and attachment snapshots after an abandoned owner render', async () => {
    const attachmentB: StagedAttachment = {
      ...stagedAttachments[0]!, id: 'attachment-b', filename: 'retained.pdf', sha256: 'b'.repeat(64),
    };
    const abandoned = new Promise<void>(() => undefined);
    let renderedAbandonedOwner = false;
    let finishCommand!: (result: Awaited<ReturnType<typeof commandApi.streamCommandEvents>>) => void;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(() => new Promise((resolve) => {
      finishCommand = resolve;
    }));
    const onCommandFinished = vi.fn();

    function SuspendAfterPane({ suspend }: { suspend: boolean }) {
      if (suspend) {
        renderedAbandonedOwner = true;
        throw abandoned;
      }
      return null;
    }

    function ConcurrentTerminalHarness() {
      const [showGhostOwner, setShowGhostOwner] = useState(false);
      const [draft, setDraft] = useState('attempt A');
      const selected: WorkspaceSelection = showGhostOwner
        ? { ...selection, conversationId: 'conversation-ghost' }
        : selection;
      const selectedConversation = showGhostOwner
        ? { ...conversation, id: 'conversation-ghost', title: 'Ghost Conversation' }
        : conversation;
      return <>
        <button type="button" onClick={() => {
          startTransition(() => {
            setDraft('ghost draft');
            setShowGhostOwner(true);
          });
        }}>尝试切换 terminal ghost</button>
        <Suspense fallback={<p>terminal ghost fallback</p>}>
          <ConversationPane
            ownerIdentity="demo:user-1"
            selection={selected}
            conversation={selectedConversation}
            checkpoint={checkpoint}
            intents={[]}
            stagedAttachments={stagedAttachments}
            draft={draft}
            onDraftChange={setDraft}
            onAttachmentIdsChange={vi.fn()}
            onCommandFinished={onCommandFinished}
          />
          <SuspendAfterPane suspend={showGhostOwner} />
        </Suspense>
      </>;
    }

    render(<ConcurrentTerminalHarness />);
    await screen.findByText('Answer');
    const committedOwnerChange = attachmentHarness.changes.get('conversation:conversation-a')!;
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(commandApi.streamCommandEvents).toHaveBeenCalledOnce());
    await userEvent.clear(screen.getByRole('textbox', { name: 'Workflow Input' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'retained A draft');
    await act(async () => committedOwnerChange(
      'conversation:conversation-a',
      (current) => [...current, attachmentB],
    ));
    expect(await screen.findByText('retained.pdf')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '尝试切换 terminal ghost' }));
    await waitFor(() => expect(renderedAbandonedOwner).toBe(true));
    expect(screen.getByRole('heading', { name: 'Evidence review' })).toBeInTheDocument();
    expect(screen.queryByText('terminal ghost fallback')).not.toBeInTheDocument();

    await act(async () => finishCommand({
      lastEventId: 1,
      finished: {
        outcome: 'succeeded', contextId: 'context-a', routeId: 'route-a',
        conversationId: 'conversation-a', checkpointId: 'checkpoint-next',
      },
    }));

    await waitFor(() => expect(onCommandFinished).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded' }),
      { draft: 'retained A draft', attachmentIds: ['attachment-b'] },
    ));
  });

  it('hands a real upload that resolves after terminal success to the created Conversation owner', async () => {
    attachmentHarness.useRealPanel = true;
    const lateAttachment: StagedAttachment = {
      ...stagedAttachments[0]!,
      id: 'attachment-late',
      filename: 'late-evidence.pdf',
      sha256: 'b'.repeat(64),
    };
    let releaseUpload!: (attachment: StagedAttachment) => void;
    vi.mocked(assetApi.stageAttachment).mockImplementationOnce(() => new Promise((resolve) => {
      releaseUpload = resolve;
    }));
    const onAttachmentIdsChange = vi.fn();

    function TerminalHandoffHarness() {
      const [currentSelection, setCurrentSelection] = useState<WorkspaceSelection>({
        contextId: conversation.contextId,
        routeId: conversation.routeId,
        virtualConversationId: 'virtual:new:late-upload',
        checkpointId: checkpoint.id,
      });
      const [draft, setDraft] = useState('create the real conversation');
      return <ConversationPane
        ownerIdentity="demo:user-1"
        selection={currentSelection}
        conversation={currentSelection.conversationId ? conversation : undefined}
        checkpoint={checkpoint}
        intents={[]}
        stagedAttachments={[]}
        draft={draft}
        onDraftChange={setDraft}
        onAttachmentIdsChange={onAttachmentIdsChange}
        onCommandFinished={(result) => {
          setCurrentSelection({
            contextId: result.contextId,
            routeId: result.routeId,
            conversationId: result.conversationId,
            checkpointId: result.checkpointId,
          });
        }}
      />;
    }

    render(<TerminalHandoffHarness />);
    await userEvent.upload(
      screen.getByLabelText('添加附件'),
      new File(['late evidence'], 'late-evidence.pdf', {
        type: 'application/pdf',
      }),
    );
    await waitFor(() => expect(assetApi.stageAttachment).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(await screen.findByRole('heading', {
      name: 'Evidence review',
    })).toBeInTheDocument();
    expect(screen.queryByText('late-evidence.pdf')).not.toBeInTheDocument();

    await act(async () => releaseUpload(lateAttachment));

    expect(await screen.findByText('late-evidence.pdf')).toBeInTheDocument();
    await waitFor(() => expect(onAttachmentIdsChange)
      .toHaveBeenLastCalledWith(['attachment-late']));
  });

  it('does not reuse a terminal attachment handoff when the same virtual primary owner reappears', async () => {
    function ReusedVirtualPrimaryHarness() {
      const [real, setReal] = useState(false);
      const [draft, setDraft] = useState('create A');
      const selected: WorkspaceSelection = real
        ? selection
        : {
          contextId: selection.contextId,
          routeId: selection.routeId,
          virtualConversationId: 'virtual:primary:route-a',
          checkpointId: checkpoint.id,
        };
      return <>
        {real && <button type="button" onClick={() => {
          setReal(false);
          setDraft('new virtual input');
        }}>归档 A 并返回 virtual primary</button>}
        <ConversationPane
          ownerIdentity="demo:user-1"
          selection={selected}
          conversation={real ? conversation : undefined}
          checkpoint={checkpoint}
          intents={[]}
          stagedAttachments={[]}
          draft={draft}
          onDraftChange={setDraft}
          onCommandFinished={() => setReal(true)}
        />
      </>;
    }
    render(<ReusedVirtualPrimaryHarness />);
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(await screen.findByRole('heading', { name: 'Evidence review' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '归档 A 并返回 virtual primary' }));
    expect(await screen.findByRole('heading', { name: '主 Conversation' })).toBeInTheDocument();

    const virtualOwnerKey = [...attachmentHarness.changes.keys()].find((key) => key.startsWith('draft:'))!;
    const currentVirtualChange = attachmentHarness.changes.get(virtualOwnerKey)!;
    await act(async () => currentVirtualChange(virtualOwnerKey, () => stagedAttachments));

    expect(await screen.findByText('evidence.pdf')).toBeInTheDocument();
  });

  it('adopts restored parent attachments when a pending owner becomes ready', async () => {
    const attachmentB: StagedAttachment = {
      ...stagedAttachments[0]!, id: 'attachment-b', filename: 'restored-b.pdf', sha256: 'b'.repeat(64),
    };
    const onAttachmentIdsChange = vi.fn();
    function PendingOwnerHarness() {
      const [pendingB, setPendingB] = useState(false);
      const [readyB, setReadyB] = useState(false);
      return <>
        <button type="button" onClick={() => setPendingB(true)}>打开 pending B</button>
        <button type="button" onClick={() => setReadyB(true)}>完成 B owner</button>
        <ConversationPane
          ownerIdentity={pendingB ? 'demo:user-b' : 'demo:user-a'}
          selection={selection}
          conversation={conversation}
          checkpoint={checkpoint}
          intents={[]}
          stagedAttachments={pendingB && readyB ? [attachmentB] : []}
          draft=""
          scopeReady={!pendingB || readyB}
          onDraftChange={vi.fn()}
          onAttachmentIdsChange={onAttachmentIdsChange}
          onCommandFinished={vi.fn()}
        />
      </>;
    }
    render(<PendingOwnerHarness />);
    await screen.findByText('Answer');
    await userEvent.click(screen.getByRole('button', { name: '打开 pending B' }));
    expect(screen.queryByText('restored-b.pdf')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '完成 B owner' }));
    expect(await screen.findByText('restored-b.pdf')).toBeInTheDocument();
    expect(onAttachmentIdsChange).not.toHaveBeenCalledWith([]);
  });

  it('does not load a real Conversation until its pending scope becomes ready', async () => {
    function ScopeReadyHarness() {
      const [ready, setReady] = useState(false);
      return <>
        <button type="button" onClick={() => setReady(true)}>resolve scope</button>
        <ConversationPane
          ownerIdentity="demo:user-1"
          selection={selection}
          conversation={conversation}
          checkpoint={checkpoint}
          intents={[]}
          stagedAttachments={[]}
          draft=""
          scopeReady={ready}
          onDraftChange={vi.fn()}
          onCommandFinished={vi.fn()}
        />
      </>;
    }
    render(<ScopeReadyHarness />);
    await act(async () => undefined);
    expect(commandApi.listConversationMessages).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'resolve scope' }));
    expect(await screen.findByText('Answer')).toBeInTheDocument();
    expect(commandApi.listConversationMessages).toHaveBeenCalledOnce();
  });

  it('isolates an in-progress Interrupt reply by logical owner identity', async () => {
    vi.mocked(commandApi.listConversationMessages).mockResolvedValue({
      messages: [], pendingInterrupt: { id: 'interrupt-a', prompt: '请选择来源' },
    });
    function InterruptIdentityHarness() {
      const [ownerIdentity, setOwnerIdentity] = useState('demo:user-a');
      return <>
        <button type="button" onClick={() => setOwnerIdentity((current) => (
          current === 'demo:user-a' ? 'demo:user-b' : 'demo:user-a'
        ))}>切换 interrupt identity</button>
        <ConversationPane
          ownerIdentity={ownerIdentity}
          selection={selection}
          conversation={conversation}
          checkpoint={checkpoint}
          intents={[]}
          stagedAttachments={[]}
          draft=""
          onDraftChange={vi.fn()}
          onCommandFinished={vi.fn()}
        />
      </>;
    }
    render(<InterruptIdentityHarness />);
    const reply = await screen.findByRole('textbox', { name: 'Interrupt 回复' });
    await userEvent.type(reply, 'A 的私密回复');

    await userEvent.click(screen.getByRole('button', { name: '切换 interrupt identity' }));
    expect(await screen.findByRole('textbox', { name: 'Interrupt 回复' })).toHaveValue('');
    expect(screen.getByRole('button', { name: '继续 Workflow' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: '切换 interrupt identity' }));
    expect(await screen.findByRole('textbox', { name: 'Interrupt 回复' })).toHaveValue('A 的私密回复');
  });

  it('never renders the previous owner messages or Interrupt while the new owner reload is deferred', async () => {
    let releaseOwnerB!: (value: Awaited<ReturnType<typeof commandApi.listConversationMessages>>) => void;
    vi.mocked(commandApi.listConversationMessages)
      .mockResolvedValueOnce({
        messages: [{
          id: 'message-a', commandId: 'command-a', role: 'assistant', content: 'A private history',
          sequence: 1, createdAt: checkpoint.createdAt,
        }],
        pendingInterrupt: { id: 'interrupt-a', prompt: 'A private interrupt' },
      })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOwnerB = resolve; }));
    function DeferredOwnerHarness() {
      const [ownerIdentity, setOwnerIdentity] = useState('demo:user-a');
      return <>
        <button type="button" onClick={() => setOwnerIdentity('demo:user-b')}>切换 deferred owner</button>
        <ConversationPane
          ownerIdentity={ownerIdentity}
          selection={selection}
          conversation={conversation}
          checkpoint={checkpoint}
          intents={[]}
          stagedAttachments={[]}
          draft=""
          onDraftChange={vi.fn()}
          onCommandFinished={vi.fn()}
        />
      </>;
    }
    render(<DeferredOwnerHarness />);
    expect(await screen.findByText('A private history')).toBeInTheDocument();
    expect(screen.getByText('A private interrupt')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '切换 deferred owner' }));
    expect(screen.queryByText('A private history')).not.toBeInTheDocument();
    expect(screen.queryByText('A private interrupt')).not.toBeInTheDocument();

    await act(async () => releaseOwnerB({
      messages: [{
        id: 'message-b', commandId: 'command-b', role: 'assistant', content: 'B private history',
        sequence: 1, createdAt: checkpoint.createdAt,
      }],
      pendingInterrupt: { id: 'interrupt-b', prompt: 'B private interrupt' },
    }));
    expect(await screen.findByText('B private history')).toBeInTheDocument();
    expect(screen.getByText('B private interrupt')).toBeInTheDocument();
  });

  it('keeps the conflict retry snapshot while moving from history to the Route head', async () => {
    const head = { ...checkpoint, id: 'checkpoint-head-next', version: 4 };
    const old = { ...checkpoint, id: 'checkpoint-old', version: 1 };
    vi.mocked(commandApi.streamCommandEvents)
      .mockResolvedValueOnce({ lastEventId: 1, finished: { outcome: 'conflict', code: 'CHECKPOINT_VERSION_CONFLICT' } })
      .mockResolvedValueOnce({ lastEventId: 1, finished: { outcome: 'succeeded', checkpointId: 'checkpoint-after-retry' } });
    function ConflictHarness() {
      const [selected, setSelected] = useState(old);
      const [draft, setDraft] = useState('  retry exactly  ');
      return <ConversationPane
        ownerIdentity="demo:user-1"
        selection={{ ...selection, checkpointId: selected.id }}
        conversation={conversation}
        checkpoint={selected}
        intents={[]}
        stagedAttachments={stagedAttachments}
        draft={draft}
        onDraftChange={setDraft}
        isHistorical={selected.id === old.id}
        onCommandFinished={vi.fn()}
        onConflict={() => setSelected(head)}
      />;
    }
    render(<ConflictHarness />);
    await screen.findByText('Answer');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('CHECKPOINT_VERSION_CONFLICT');
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('  retry exactly  ');
    expect(screen.getByText('evidence.pdf')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    const retry = vi.mocked(commandApi.createWorkflowCommand).mock.calls[1]![0];
    expect(retry).toMatchObject({
      baseCheckpointId: head.id,
      expectedCheckpointVersion: head.version,
      input: { type: 'message', content: '  retry exactly  ' },
      attachmentIds: ['attachment-a'],
    });
  });

  it('does not let an old controller finally unlock a newer owner command', async () => {
    let releaseOld!: () => void;
    let newerSignal: AbortSignal | undefined;
    vi.mocked(commandApi.streamCommandEvents)
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseOld = resolve; });
        throw new TypeError('old transport finished late');
      })
      .mockImplementationOnce(async (_url, options) => {
        newerSignal = options.signal;
        await new Promise<void>(() => undefined);
        throw new Error('unreachable');
      });
    function ControllerHarness() {
      const [owner, setOwner] = useState('virtual:new:a');
      const [draft, setDraft] = useState('owner a');
      return <>
        <button type="button" onClick={() => {
          setOwner('virtual:new:b');
          setDraft('owner b');
        }}>切换 command owner</button>
        <ConversationPane
          ownerIdentity="demo:user-1"
          selection={{ contextId: 'context-a', routeId: 'route-a', virtualConversationId: owner, checkpointId: checkpoint.id }}
          checkpoint={checkpoint}
          intents={[]}
          stagedAttachments={[]}
          draft={draft}
          onDraftChange={setDraft}
          onCommandFinished={vi.fn()}
        />
      </>;
    }
    render(<ControllerHarness />);
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(releaseOld).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: '切换 command owner' }));
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(newerSignal).toBeDefined());

    await act(async () => releaseOld());
    expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledTimes(2);
  });
});
