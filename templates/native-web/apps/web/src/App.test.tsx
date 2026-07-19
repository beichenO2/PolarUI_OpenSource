import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense, startTransition, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type {
  CheckpointArtifact,
  ContextWorkspace,
  RouteWorkspace,
  StageProjectionSnapshot,
  WorkflowCheckpoint,
  WorkflowContext,
  WorkflowConversation,
  WorkflowRoute,
} from './domain/api';
import * as commandApi from './commands/api';
import type { MemoryItem } from './memory/api';

const appAttachmentHarness = vi.hoisted(() => ({
  deferredCompletions: [] as Array<() => void>,
}));

vi.mock('./assets/AttachmentPanel', () => ({
  AttachmentPanel: ({ staged, onChange, conversationId, draftKey }: {
    staged: Array<{ id: string; filename: string }>;
    onChange(ownerKey: string, update: (current: unknown[]) => unknown[]): void;
    conversationId?: string;
    draftKey?: string;
  }) => <div aria-label="附件区">
    {staged.map(({ id, filename }) => <span key={id}>{filename}</span>)}
    <button type="button" onClick={() => onChange(
      conversationId ? `conversation:${conversationId}` : `draft:${draftKey ?? 'default'}`,
      () => [{
        id: 'attachment-owned', filename: 'owned.pdf', mediaType: 'application/pdf', byteSize: 12,
        sha256: 'a'.repeat(64), status: 'pending', conversationId: null, createdAt: checkpoint.createdAt,
      }],
    )}>测试暂存附件</button>
    <button type="button" onClick={() => {
      appAttachmentHarness.deferredCompletions.push(() => onChange(
        conversationId ? `conversation:${conversationId}` : `draft:${draftKey ?? 'default'}`,
        () => [{
          id: 'attachment-late-owned', filename: 'late-owned.pdf', mediaType: 'application/pdf', byteSize: 18,
          sha256: 'b'.repeat(64), status: 'pending', conversationId: null, createdAt: checkpoint.createdAt,
        }],
      ));
    }}>开始延迟暂存附件</button>
  </div>,
}));
vi.mock('./commands/api', async () => {
  const actual = await vi.importActual<typeof import('./commands/api')>('./commands/api');
  return {
    ...actual,
    listConversationMessages: vi.fn(),
    createWorkflowCommand: vi.fn(),
    streamCommandEvents: vi.fn(),
  };
});

const manifest = {
  contract_version: '1.0' as const,
  product: { id: 'demo', name: 'Workflow Workspace', context_label: '项目', route_label: '路线' },
  workflow: { id: 'demo' },
  intents: [{ key: 'summarize', label: '生成摘要' }],
  stages: [],
};
const user = { id: 'user-1', email: 'reader@example.test', username: 'reader' };
const context: WorkflowContext = {
  id: 'context-a', title: 'Project Alpha', status: 'active',
  createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
};
const route: WorkflowRoute = {
  id: 'route-a', contextId: context.id, name: '主路线', originCheckpointId: null,
  headCheckpointId: 'checkpoint-head',
  createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
};
const checkpoint: WorkflowCheckpoint = {
  id: 'checkpoint-head', contextId: context.id, routeId: route.id, parentCheckpointId: null,
  version: 2, stageKey: null, reason: 'workflow_action',
  snapshot: { workflowState: {}, memoryReferences: [], artifacts: [] },
  createdAt: '2026-07-18T00:00:00.000Z',
};
const conversation: WorkflowConversation = {
  id: 'conversation-a', contextId: context.id, routeId: route.id, title: '主要讨论',
  titleSource: 'agent', isPrimary: true, status: 'active',
  createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
};
const conversationB: WorkflowConversation = {
  ...conversation, id: 'conversation-b', title: '第二讨论', isPrimary: false,
};
const settlementContext: WorkflowContext = {
  ...context,
  id: 'context-settlement',
  title: 'Project Settlement',
  updatedAt: '2026-07-19T00:00:00.000Z',
};
const settlementRoute: WorkflowRoute = {
  ...route,
  id: 'route-settlement',
  contextId: settlementContext.id,
  headCheckpointId: 'checkpoint-settlement',
  updatedAt: '2026-07-19T00:00:00.000Z',
};
const settlementCheckpoint: WorkflowCheckpoint = {
  ...checkpoint,
  id: 'checkpoint-settlement',
  contextId: settlementContext.id,
  routeId: settlementRoute.id,
  version: 1,
};
const settlementConversation: WorkflowConversation = {
  ...conversation,
  id: 'conversation-settlement',
  contextId: settlementContext.id,
  routeId: settlementRoute.id,
  title: 'Settlement discussion',
  updatedAt: '2026-07-19T00:00:00.000Z',
};

function routeWorkspace(options: {
  context?: WorkflowContext;
  route?: WorkflowRoute;
  conversations?: WorkflowConversation[];
  selectedCheckpoint?: WorkflowCheckpoint;
  headCheckpoint?: WorkflowCheckpoint;
  artifacts?: CheckpointArtifact[];
  stageProjection?: StageProjectionSnapshot;
} = {}): RouteWorkspace {
  const selectedContext = options.context ?? context;
  const selectedRoute = options.route ?? route;
  const head = options.headCheckpoint ?? checkpoint;
  const selected = options.selectedCheckpoint ?? head;
  return {
    context: selectedContext,
    route: selectedRoute,
    checkpoints: selected.id === head.id ? [head] : [head, selected],
    conversations: options.conversations ?? [conversation],
    selectedCheckpoint: selected,
    headCheckpoint: head,
    isHistorical: selected.id !== head.id,
    artifacts: options.artifacts ?? [],
    ...(options.stageProjection === undefined ? {} : { stageProjection: options.stageProjection }),
  };
}

interface ApiModel {
  contexts: WorkflowContext[];
  contextWorkspaces: Record<string, ContextWorkspace>;
  routeWorkspaces: Record<string, RouteWorkspace>;
  override?: (url: string, init?: RequestInit) => Promise<Response> | undefined;
}

function installApi(model: ApiModel) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const overridden = model.override?.(url, init);
    if (overridden) return overridden;
    if (url.startsWith('/api/memory?')) return Response.json({ memories: [] });
    if (/^\/api\/memory\/[^/]+\/versions$/.test(url)) return Response.json({ versions: [] });
    if (url === '/api/contexts') return Response.json({ contexts: model.contexts });
    const contextMatch = /^\/api\/contexts\/([^/]+)\/workspace$/.exec(url);
    if (contextMatch) {
      const value = model.contextWorkspaces[decodeURIComponent(contextMatch[1]!)];
      return value ? Response.json(value) : Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    const routeMatch = /^\/api\/routes\/([^/?]+)\/workspace(?:\?checkpoint=([^&]+))?$/.exec(url);
    if (routeMatch) {
      const value = model.routeWorkspaces[decodeURIComponent(routeMatch[1]!)];
      return value ? Response.json(value) : Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function defaultModel(conversations: WorkflowConversation[] = [conversation]): ApiModel {
  return {
    contexts: [context],
    contextWorkspaces: { [context.id]: { context, routes: [route] } },
    routeWorkspaces: { [route.id]: routeWorkspace({ conversations }) },
  };
}

function settlementModel(): ApiModel {
  return {
    contexts: [context, settlementContext],
    contextWorkspaces: {
      [context.id]: { context, routes: [route] },
      [settlementContext.id]: {
        context: settlementContext,
        routes: [settlementRoute],
      },
    },
    routeWorkspaces: {
      [route.id]: routeWorkspace(),
      [settlementRoute.id]: routeWorkspace({
        context: settlementContext,
        route: settlementRoute,
        conversations: [settlementConversation],
        selectedCheckpoint: settlementCheckpoint,
        headCheckpoint: settlementCheckpoint,
      }),
    },
  };
}

beforeEach(() => {
  appAttachmentHarness.deferredCompletions.length = 0;
  history.replaceState({}, '', '/');
  localStorage.clear();
  vi.mocked(commandApi.listConversationMessages).mockReset().mockResolvedValue({ messages: [], pendingInterrupt: null });
  vi.mocked(commandApi.createWorkflowCommand).mockReset().mockImplementation(async (input) => ({
    commandId: input.commandId, eventUrl: `/api/commands/${input.commandId}/events`,
  }));
  vi.mocked(commandApi.streamCommandEvents).mockReset().mockResolvedValue({
    lastEventId: 1,
    finished: { outcome: 'succeeded', contextId: context.id, routeId: route.id, conversationId: conversation.id, checkpointId: checkpoint.id },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('conversation-first App shell', () => {
  it('keeps a provisional bootstrap draft exact while identity loads, then hands it to the real hook', async () => {
    let releaseContexts!: () => void;
    const contextsGate = new Promise<void>((resolve) => { releaseContexts = resolve; });
    installApi({
      contexts: [], contextWorkspaces: {}, routeWorkspaces: {},
      override: (url) => url === '/api/contexts'
        ? contextsGate.then(() => Response.json({ contexts: [] }))
        : undefined,
    });
    render(<App manifest={manifest} user={user} />);

    const input = screen.getByRole('textbox', { name: 'Workflow Input' });
    expect(input).toBeEnabled();
    await userEvent.type(input, '  bootstrap exact  ');
    expect(input).toHaveValue('  bootstrap exact  ');
    expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成摘要' })).toBeDisabled();

    await act(async () => releaseContexts());
    await waitFor(() => expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeEnabled());
    expect(input).toHaveValue('  bootstrap exact  ');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      input: { type: 'message', content: '  bootstrap exact  ' },
    }), expect.anything());
  });

  it('enables zero-Context Workflow Input with no naming or Stage gate', async () => {
    installApi({ contexts: [], contextWorkspaces: {}, routeWorkspaces: {} });
    render(<App manifest={manifest} user={user} />);
    const input = await screen.findByRole('textbox', { name: 'Workflow Input' });
    expect(input).toBeEnabled();
    expect(screen.queryByRole('button', { name: /创建第一个/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/名称/)).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /Stage|阶段/ })).not.toBeInTheDocument();
  });

  it('renders a virtual primary Conversation when a Context has none', async () => {
    installApi(defaultModel([]));
    render(<App manifest={manifest} user={user} />);
    expect((await screen.findAllByText('主 Conversation')).length).toBeGreaterThan(0);
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toBeEnabled();
    expect(commandApi.listConversationMessages).not.toHaveBeenCalled();
  });

  it('creates an untitled virtual Conversation immediately from plus', async () => {
    installApi(defaultModel());
    render(<App manifest={manifest} user={user} />);
    expect((await screen.findAllByText('主要讨论')).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: '新建 Conversation' }));
    expect((await screen.findAllByText('未命名 Conversation')).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/Conversation 名称/)).not.toBeInTheDocument();
  });

  it('immediately owns a real Conversation navigation and ignores the old late terminal event', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let routeRequests = 0;
    let releaseTarget!: () => void;
    const targetGate = new Promise<void>((resolve) => { releaseTarget = resolve; });
    const model = defaultModel([conversation, conversationB]);
    model.override = (url) => {
      if (url !== `/api/routes/${route.id}/workspace`) return undefined;
      routeRequests += 1;
      return routeRequests === 1
        ? Promise.resolve(Response.json(model.routeWorkspaces[route.id]))
        : targetGate.then(() => Response.json(model.routeWorkspaces[route.id]));
    };
    installApi(model);
    let streamSignal: AbortSignal | undefined;
    let finishOld!: (value: { lastEventId: number; finished: commandApi.CommandFinishedPayload }) => void;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce((_url, options) => {
      streamSignal = options.signal;
      return new Promise((resolve) => { finishOld = resolve; });
    });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'old command');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(streamSignal).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: /^第二讨论 主路线/ }));
    expect(location.pathname).toContain(`/conversations/${conversationB.id}`);
    await waitFor(() => expect(streamSignal?.aborted).toBe(true));
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('');
    expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeDisabled();

    await act(async () => finishOld({
      lastEventId: 1,
      finished: { outcome: 'succeeded', contextId: context.id, routeId: route.id, conversationId: conversation.id, checkpointId: checkpoint.id },
    }));
    await act(async () => releaseTarget());
    await waitFor(() => expect(screen.getByRole('button', { name: /^第二讨论 主路线/ })).toHaveAttribute('aria-current', 'page'));
    expect(location.pathname).toContain(`/conversations/${conversationB.id}`);
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toBeEnabled();
  });

  it('immediately changes owner while a Context navigation is deferred', async () => {
    const contextB: WorkflowContext = { ...context, id: 'context-b', title: 'Project Beta', updatedAt: '2026-07-17T00:00:00.000Z' };
    const routeB: WorkflowRoute = { ...route, id: 'route-b', contextId: contextB.id, name: 'Beta Route' };
    const checkpointB: WorkflowCheckpoint = { ...checkpoint, id: 'checkpoint-b', contextId: contextB.id, routeId: routeB.id };
    const conversationBeta: WorkflowConversation = { ...conversation, id: 'conversation-beta', contextId: contextB.id, routeId: routeB.id, title: 'Beta Conversation' };
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let releaseContextB!: () => void;
    const contextGate = new Promise<void>((resolve) => { releaseContextB = resolve; });
    const model = defaultModel();
    model.contexts = [context, contextB];
    model.contextWorkspaces[contextB.id] = { context: contextB, routes: [routeB] };
    model.routeWorkspaces[routeB.id] = routeWorkspace({ context: contextB, route: routeB, headCheckpoint: checkpointB, conversations: [conversationBeta] });
    model.override = (url) => url === `/api/contexts/${contextB.id}/workspace`
      ? contextGate.then(() => Response.json(model.contextWorkspaces[contextB.id]))
      : undefined;
    installApi(model);
    let streamSignal: AbortSignal | undefined;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(async (_url, options) => {
      streamSignal = options.signal;
      await new Promise<void>(() => undefined);
      throw new Error('unreachable');
    });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'context a command');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(streamSignal).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: /Project Beta 打开/ }));
    await waitFor(() => expect(streamSignal?.aborted).toBe(true));
    expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeDisabled();
    await act(async () => releaseContextB());
    expect(await screen.findByRole('heading', { name: 'Project Beta' })).toBeInTheDocument();
    expect(location.pathname).toContain(`/contexts/${contextB.id}/routes/${routeB.id}`);
  });

  it('aborts the current command immediately for a direct popstate while the target is deferred', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let routeRequests = 0;
    let releaseTarget!: () => void;
    const targetGate = new Promise<void>((resolve) => { releaseTarget = resolve; });
    const model = defaultModel([conversation, conversationB]);
    model.override = (url) => {
      if (url !== `/api/routes/${route.id}/workspace`) return undefined;
      routeRequests += 1;
      return routeRequests === 1
        ? Promise.resolve(Response.json(model.routeWorkspaces[route.id]))
        : targetGate.then(() => Response.json(model.routeWorkspaces[route.id]));
    };
    installApi(model);
    let streamSignal: AbortSignal | undefined;
    let finishOld!: (value: { lastEventId: number; finished: commandApi.CommandFinishedPayload }) => void;
    vi.mocked(commandApi.listConversationMessages).mockResolvedValueOnce({
      messages: [{
        id: 'private-a', commandId: 'command-private-a', role: 'assistant',
        content: 'A private popstate history', sequence: 1, createdAt: checkpoint.createdAt,
      }],
      pendingInterrupt: { id: 'interrupt-private-a', prompt: 'A private popstate interrupt' },
    });
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce((_url, options) => {
      streamSignal = options.signal;
      return new Promise((resolve) => { finishOld = resolve; });
    });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');
    expect(await screen.findByText('A private popstate history')).toBeInTheDocument();
    expect(screen.getByText('A private popstate interrupt')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '测试暂存附件' }));
    expect(await screen.findByText('owned.pdf')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Interrupt 回复' }), 'dismiss old interrupt');
    vi.mocked(commandApi.listConversationMessages).mockImplementationOnce(() => new Promise(() => undefined));
    await userEvent.click(screen.getByRole('button', { name: '继续 Workflow' }));
    await waitFor(() => expect(streamSignal).toBeDefined());

    act(() => {
      history.pushState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversationB.id}`);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });
    expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeDisabled();
    expect(screen.queryByText('A private popstate history')).not.toBeInTheDocument();
    expect(screen.queryByText('A private popstate interrupt')).not.toBeInTheDocument();
    expect(screen.queryByText('owned.pdf')).not.toBeInTheDocument();
    await waitFor(() => expect(streamSignal?.aborted).toBe(true));

    await act(async () => finishOld({
      lastEventId: 1,
      finished: { outcome: 'succeeded', contextId: context.id, routeId: route.id, conversationId: conversation.id, checkpointId: checkpoint.id },
    }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledTimes(1);
    await act(async () => releaseTarget());
    await waitFor(() => expect(screen.getByRole('button', { name: /^第二讨论 主路线/ })).toHaveAttribute('aria-current', 'page'));
  });

  it('keeps Start and intents disabled after initial workspace failure and exposes retry', async () => {
    let failing = true;
    const model: ApiModel = { contexts: [], contextWorkspaces: {}, routeWorkspaces: {} };
    model.override = (url) => url === '/api/contexts'
      ? Promise.resolve(failing
        ? Response.json({ error: { code: 'WORKSPACE_UNAVAILABLE' } }, { status: 503 })
        : Response.json({ contexts: [] }))
      : undefined;
    installApi(model);
    render(<App manifest={manifest} user={user} />);

    expect(await screen.findByText('工作空间暂时无法同步。Input 与附件仍保留在当前 Conversation。')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'keep this draft');
    await userEvent.click(screen.getByRole('button', { name: '测试暂存附件' }));
    expect(await screen.findByText('owned.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成摘要' })).toBeDisabled();
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: '重试同步' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('keep this draft');
    expect(screen.getByText('owned.pdf')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIds: ['attachment-owned'],
    }), expect.anything());
  });

  it('hands a bootstrap upload that completes after retry resolution to the resolved owner', async () => {
    let failing = true;
    const model: ApiModel = { contexts: [], contextWorkspaces: {}, routeWorkspaces: {} };
    model.override = (url) => url === '/api/contexts'
      ? Promise.resolve(failing
        ? Response.json({ error: { code: 'WORKSPACE_UNAVAILABLE' } }, { status: 503 })
        : Response.json({ contexts: [] }))
      : undefined;
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findByText('工作空间暂时无法同步。Input 与附件仍保留在当前 Conversation。');
    await userEvent.click(screen.getByRole('button', { name: '开始延迟暂存附件' }));
    expect(appAttachmentHarness.deferredCompletions).toHaveLength(1);

    failing = false;
    await userEvent.click(screen.getByRole('button', { name: '重试同步' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '生成摘要' })).toBeEnabled());
    await act(async () => appAttachmentHarness.deferredCompletions[0]!());

    expect(await screen.findByText('late-owned.pdf')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'use late upload');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      attachmentIds: ['attachment-late-owned'],
    }), expect.anything());
  });

  it('restores the source owner after a navigation error and offers retry or return', async () => {
    const contextB: WorkflowContext = { ...context, id: 'context-b', title: 'Project Beta', updatedAt: '2026-07-17T00:00:00.000Z' };
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    const model = defaultModel();
    model.contexts = [context, contextB];
    model.override = (url) => url === `/api/contexts/${contextB.id}/workspace`
      ? Promise.resolve(Response.json({ error: { code: 'WORKSPACE_UNAVAILABLE' } }, { status: 503 }))
      : undefined;
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'source draft');
    await userEvent.click(screen.getByRole('button', { name: '测试暂存附件' }));
    expect(await screen.findByText('owned.pdf')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Project Beta 打开/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('工作空间暂时无法同步');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('source draft'));
    expect(screen.getByText('owned.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试打开目标' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回原 Conversation' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '返回原 Conversation' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('source draft');
    expect(screen.getByText('owned.pdf')).toBeInTheDocument();
  });

  it('keeps a failed Command settlement on the editable target and retries its latest composer', async () => {
    history.replaceState(
      {},
      '',
      `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`,
    );
    let targetFails = true;
    const model = settlementModel();
    model.override = (url) => {
      if (url !== `/api/contexts/${settlementContext.id}/workspace` || !targetFails) {
        return undefined;
      }
      return Promise.resolve(Response.json(
        { error: { code: 'WORKSPACE_UNAVAILABLE' } },
        { status: 503 },
      ));
    };
    installApi(model);
    vi.mocked(commandApi.streamCommandEvents).mockResolvedValueOnce({
      lastEventId: 1,
      finished: {
        outcome: 'succeeded',
        contextId: settlementContext.id,
        routeId: settlementRoute.id,
        conversationId: settlementConversation.id,
        checkpointId: settlementCheckpoint.id,
      },
    });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Workflow Input' }),
      'create target',
    );
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('工作空间暂时无法同步');
    const targetInput = screen.getByRole('textbox', { name: 'Workflow Input' });
    await userEvent.type(targetInput, '  latest target draft  ');
    await userEvent.click(screen.getByRole('button', { name: '测试暂存附件' }));
    expect(await screen.findByText('owned.pdf')).toBeInTheDocument();

    targetFails = false;
    await userEvent.click(screen.getByRole('button', { name: '重试打开目标' }));

    expect(await screen.findByRole('heading', {
      name: 'Project Settlement',
    })).toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole('button', { name: '发送 Workflow Input' }),
    ).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Workflow Input' }))
      .toHaveValue('  latest target draft  ');
    expect(screen.getByText('owned.pdf')).toBeInTheDocument();
    expect(location.pathname).toBe(
      `/contexts/${settlementContext.id}/routes/${settlementRoute.id}` +
      `/conversations/${settlementConversation.id}`,
    );
  });

  it('hands the latest failed settlement composer back to the source owner', async () => {
    history.replaceState(
      {},
      '',
      `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`,
    );
    const model = settlementModel();
    model.override = (url) => url === `/api/contexts/${settlementContext.id}/workspace`
      ? Promise.resolve(Response.json(
        { error: { code: 'WORKSPACE_UNAVAILABLE' } },
        { status: 503 },
      ))
      : undefined;
    installApi(model);
    vi.mocked(commandApi.streamCommandEvents).mockResolvedValueOnce({
      lastEventId: 1,
      finished: {
        outcome: 'succeeded',
        contextId: settlementContext.id,
        routeId: settlementRoute.id,
        conversationId: settlementConversation.id,
        checkpointId: settlementCheckpoint.id,
      },
    });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Workflow Input' }),
      'create target',
    );
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('工作空间暂时无法同步');

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Workflow Input' }),
      'latest return draft',
    );
    await userEvent.click(screen.getByRole('button', { name: '测试暂存附件' }));
    await userEvent.click(screen.getByRole('button', { name: '返回原 Conversation' }));

    expect(await screen.findByRole('heading', {
      name: 'Project Alpha',
    })).toBeInTheDocument();
    await waitFor(() => expect(
      screen.getByRole('button', { name: '发送 Workflow Input' }),
    ).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Workflow Input' }))
      .toHaveValue('latest return draft');
    expect(screen.getByLabelText('附件区')).toHaveTextContent(
      /owned\.pdf|已暂存附件 1/,
    );
    expect(location.pathname).toBe(
      `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`,
    );
  });

  it('restores an owner-keyed pending settlement after direct navigation away and back', async () => {
    history.replaceState(
      {},
      '',
      `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`,
    );
    let targetRequests = 0;
    const model = settlementModel();
    model.override = (url) => {
      if (url !== `/api/contexts/${settlementContext.id}/workspace`) return undefined;
      targetRequests += 1;
      if (targetRequests === 1) return new Promise<Response>(() => undefined);
      return Promise.resolve(Response.json(
        model.contextWorkspaces[settlementContext.id],
      ));
    };
    installApi(model);
    vi.mocked(commandApi.streamCommandEvents).mockResolvedValueOnce({
      lastEventId: 1,
      finished: {
        outcome: 'succeeded',
        contextId: settlementContext.id,
        routeId: settlementRoute.id,
        conversationId: settlementConversation.id,
        checkpointId: settlementCheckpoint.id,
      },
    });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Workflow Input' }),
      'create deferred target',
    );
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(targetRequests).toBe(1));

    await userEvent.type(
      screen.getByRole('textbox', { name: 'Workflow Input' }),
      'pending target snapshot',
    );
    await userEvent.click(screen.getByRole('button', { name: '测试暂存附件' }));

    act(() => {
      history.pushState(
        {},
        '',
        `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`,
      );
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });
    await waitFor(() => expect(screen.getByRole('button', {
      name: /^主要讨论 主路线/,
    })).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('');

    act(() => {
      history.pushState(
        {},
        '',
        `/contexts/${settlementContext.id}/routes/${settlementRoute.id}` +
        `/conversations/${settlementConversation.id}`,
      );
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });

    expect(await screen.findByRole('heading', {
      name: 'Project Settlement',
    })).toBeInTheDocument();
    await waitFor(() => expect(targetRequests).toBe(2));
    expect(screen.getByRole('textbox', { name: 'Workflow Input' }))
      .toHaveValue('pending target snapshot');
    expect(screen.getByText('owned.pdf')).toBeInTheDocument();
  });

  it('does not activate a newer settlement snapshot for an older Checkpoint URL', async () => {
    const old = { ...settlementCheckpoint, id: 'checkpoint-settlement-old', version: 0 };
    history.replaceState(
      {},
      '',
      `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`,
    );
    let targetRequests = 0;
    const model = settlementModel();
    model.override = (url) => {
      if (url === `/api/contexts/${settlementContext.id}/workspace`) {
        targetRequests += 1;
        return targetRequests === 1
          ? new Promise<Response>(() => undefined)
          : Promise.resolve(Response.json(model.contextWorkspaces[settlementContext.id]));
      }
      if (url === `/api/routes/${settlementRoute.id}/workspace?checkpoint=${old.id}`) {
        return Promise.resolve(Response.json(routeWorkspace({
          context: settlementContext,
          route: settlementRoute,
          conversations: [settlementConversation],
          selectedCheckpoint: old,
          headCheckpoint: settlementCheckpoint,
        })));
      }
      return undefined;
    };
    installApi(model);
    vi.mocked(commandApi.streamCommandEvents).mockResolvedValueOnce({
      lastEventId: 1,
      finished: {
        outcome: 'succeeded', contextId: settlementContext.id, routeId: settlementRoute.id,
        conversationId: settlementConversation.id, checkpointId: settlementCheckpoint.id,
      },
    });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'new settlement');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(targetRequests).toBe(1));

    act(() => {
      history.pushState(
        {},
        '',
        `/contexts/${settlementContext.id}/routes/${settlementRoute.id}` +
        `/conversations/${settlementConversation.id}?checkpoint=${old.id}`,
      );
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    });

    expect(await screen.findByRole('note')).toHaveTextContent('正在查看历史投影');
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'branch old');
    await waitFor(() => expect(
      screen.getByRole('button', { name: '发送 Workflow Input' }),
    ).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(vi.mocked(commandApi.createWorkflowCommand).mock.calls[1]![0]).toMatchObject({
      baseCheckpointId: old.id,
      expectedCheckpointVersion: old.version,
    });
  });

  it('accepts the canonical preferred Conversation when a requested Conversation became archived', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let routeRequests = 0;
    const model = defaultModel([conversation, conversationB]);
    model.override = (url) => {
      if (url !== `/api/routes/${route.id}/workspace`) return undefined;
      routeRequests += 1;
      return Promise.resolve(Response.json(routeRequests === 1
        ? routeWorkspace({ conversations: [conversation, conversationB] })
        : routeWorkspace({ conversations: [conversation, { ...conversationB, status: 'archived' }] })));
    };
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');
    await userEvent.click(screen.getByRole('button', { name: /^第二讨论 主路线/ }));

    await waitFor(() => expect(location.pathname).toContain(`/conversations/${conversation.id}`));
    await waitFor(() => expect(screen.getByRole('button', { name: '生成摘要' })).toBeEnabled());
    expect(screen.getByRole('button', { name: /^主要讨论 主路线/ }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('accepts the canonical preferred Context when a requested Context became unavailable', async () => {
    const staleContext = { ...context, id: 'context-stale', title: 'Stale Context' };
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let staleAvailable = true;
    const model = defaultModel();
    model.contexts = [context, staleContext];
    model.override = (url) => {
      if (url !== '/api/contexts') return undefined;
      return Promise.resolve(Response.json({
        contexts: staleAvailable ? [context, staleContext] : [context],
      }));
    };
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');
    await screen.findByRole('button', { name: /Stale Context 打开/ });
    staleAvailable = false;
    await userEvent.click(screen.getByRole('button', { name: /Stale Context 打开/ }));

    await waitFor(() => expect(location.pathname).toContain(`/contexts/${context.id}/routes/${route.id}`));
    await waitFor(() => expect(screen.getByRole('button', { name: '生成摘要' })).toBeEnabled());
    expect(screen.getByRole('button', { name: /Project Alpha 当前/ })).toHaveAttribute('aria-current', 'page');
  });

  it('hands a stale Context navigation composer to the canonical zero-Context owner', async () => {
    const staleContext = { ...context, id: 'context-stale', title: 'Stale Context' };
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let canonicalize = false;
    let releaseContexts!: () => void;
    const contextsGate = new Promise<void>((resolve) => { releaseContexts = resolve; });
    const model = defaultModel();
    model.contexts = [context, staleContext];
    model.override = (url) => {
      if (url !== '/api/contexts' || !canonicalize) return undefined;
      return contextsGate.then(() => Response.json({ contexts: [] }));
    };
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');
    await screen.findByRole('button', { name: /Stale Context 打开/ });

    canonicalize = true;
    await userEvent.click(screen.getByRole('button', { name: /Stale Context 打开/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'zero owner draft');
    await userEvent.click(screen.getByRole('button', { name: '测试暂存附件' }));
    expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeDisabled();

    await act(async () => releaseContexts());

    await waitFor(() => expect(location.pathname + location.search).toBe('/'));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '生成摘要' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('zero owner draft');
    expect(screen.getByText('已暂存附件 1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      contextId: undefined,
      routeId: undefined,
      input: { type: 'message', content: 'zero owner draft' },
      attachmentIds: ['attachment-owned'],
    }), expect.anything());
  });

  it('hands a stale Context navigation composer to the canonical initializing owner', async () => {
    const staleContext = { ...context, id: 'context-stale', title: 'Stale Context' };
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let canonicalize = false;
    let releaseContexts!: () => void;
    const contextsGate = new Promise<void>((resolve) => { releaseContexts = resolve; });
    const model = defaultModel();
    model.contexts = [context, staleContext];
    model.override = (url) => {
      if (url === '/api/contexts' && canonicalize) {
        return contextsGate.then(() => Response.json({ contexts: [context] }));
      }
      if (url === `/api/contexts/${context.id}/workspace` && canonicalize) {
        return Promise.resolve(Response.json({ context, routes: [] }));
      }
      return undefined;
    };
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');
    await screen.findByRole('button', { name: /Stale Context 打开/ });

    canonicalize = true;
    await userEvent.click(screen.getByRole('button', { name: /Stale Context 打开/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'initializing owner draft');
    await userEvent.click(screen.getByRole('button', { name: '测试暂存附件' }));
    expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeDisabled();

    await act(async () => releaseContexts());

    await waitFor(() => expect(location.pathname + location.search).toBe('/'));
    await waitFor(() => expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '生成摘要' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('initializing owner draft');
    expect(screen.getByText('已暂存附件 1')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      contextId: context.id,
      routeId: undefined,
      input: { type: 'message', content: 'initializing owner draft' },
      attachmentIds: ['attachment-owned'],
    }), expect.anything());
  });

  it('moves a historical conflict to the explicit Route head URL and retries there', async () => {
    const old: WorkflowCheckpoint = { ...checkpoint, id: 'checkpoint-old', version: 1 };
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}?checkpoint=${old.id}`);
    const model = defaultModel();
    model.routeWorkspaces[route.id] = routeWorkspace({ selectedCheckpoint: old, headCheckpoint: checkpoint });
    model.override = (url) => {
      if (url === `/api/routes/${route.id}/workspace?checkpoint=${old.id}`) {
        return Promise.resolve(Response.json(routeWorkspace({ selectedCheckpoint: old, headCheckpoint: checkpoint })));
      }
      if (url === `/api/routes/${route.id}/workspace`) {
        return Promise.resolve(Response.json(routeWorkspace({ headCheckpoint: checkpoint })));
      }
      return undefined;
    };
    installApi(model);
    vi.mocked(commandApi.streamCommandEvents)
      .mockResolvedValueOnce({ lastEventId: 1, finished: { outcome: 'conflict', code: 'CHECKPOINT_VERSION_CONFLICT' } })
      .mockResolvedValueOnce({ lastEventId: 1, finished: { outcome: 'succeeded', checkpointId: 'checkpoint-retried' } });
    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('note');
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), '  historical retry  ');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));

    await waitFor(() => expect(location.search).toBe(''));
    expect(location.pathname).toBe(`/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    const retryButton = await screen.findByRole('button', { name: '重试' });
    await waitFor(() => expect(retryButton).toBeEnabled());
    await userEvent.click(retryButton);
    expect(vi.mocked(commandApi.createWorkflowCommand).mock.calls[1]![0]).toMatchObject({
      baseCheckpointId: checkpoint.id,
      input: { type: 'message', content: '  historical retry  ' },
    });
  });

  it('renames Conversation and Context metadata without aborting an in-flight Command receipt', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let routeRequests = 0;
    let releaseRouteReload!: () => void;
    const routeReloadGate = new Promise<void>((resolve) => { releaseRouteReload = resolve; });
    const model = defaultModel();
    model.override = (url, init) => {
      if (url === `/api/conversations/${conversation.id}` && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body)) as { title: string };
        return Promise.resolve(Response.json({ ...conversation, title: input.title }));
      }
      if (url === `/api/contexts/${context.id}` && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body)) as { title: string };
        return Promise.resolve(Response.json({ ...context, title: input.title }));
      }
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) {
        routeRequests += 1;
        return routeRequests === 1
          ? Promise.resolve(Response.json(model.routeWorkspaces[route.id]))
          : routeReloadGate.then(() => Response.json(model.routeWorkspaces[route.id]));
      }
      return undefined;
    };
    installApi(model);
    let streamSignal: AbortSignal | undefined;
    let finishStream!: () => void;
    const streamGate = new Promise<void>((resolve) => { finishStream = resolve; });
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(async (_url, options) => {
      streamSignal = options.signal;
      await streamGate;
      return {
        lastEventId: 1,
        finished: {
          outcome: 'succeeded', contextId: context.id, routeId: route.id,
          conversationId: conversation.id, checkpointId: checkpoint.id,
        },
      };
    });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'long command');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(streamSignal).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: '重命名 主要讨论' }));
    await userEvent.clear(screen.getByRole('textbox', { name: '重命名 Conversation' }));
    await userEvent.type(screen.getByRole('textbox', { name: '重命名 Conversation' }), 'Renamed Conversation');
    await userEvent.keyboard('{Enter}');
    expect((await screen.findAllByText('Renamed Conversation')).length).toBeGreaterThan(0);
    expect(streamSignal?.aborted).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: '重命名 Project Alpha' }));
    await userEvent.clear(screen.getByRole('textbox', { name: '重命名 Context' }));
    await userEvent.type(screen.getByRole('textbox', { name: '重命名 Context' }), 'Renamed Context');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Renamed Context' })).toBeInTheDocument();
    expect(streamSignal?.aborted).toBe(false);
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledTimes(1);
    expect(commandApi.streamCommandEvents).toHaveBeenCalledTimes(1);

    await act(async () => finishStream());
    await waitFor(() => expect(routeRequests).toBeGreaterThan(1));
    await act(async () => releaseRouteReload());
    await waitFor(() => expect(commandApi.listConversationMessages).toHaveBeenCalledTimes(2));
    expect(location.pathname).toBe(`/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    expect((await screen.findAllByText('Renamed Conversation')).length).toBeGreaterThan(0);
  });

  it('keeps a deferred Conversation history reload alive while its title is renamed', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    const model = defaultModel();
    model.override = (url, init) => {
      if (url === `/api/conversations/${conversation.id}` && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body)) as { title: string };
        return Promise.resolve(Response.json({ ...conversation, title: input.title }));
      }
      return undefined;
    };
    installApi(model);
    let historySignal: AbortSignal | undefined;
    let releaseHistory!: (value: Awaited<ReturnType<typeof commandApi.listConversationMessages>>) => void;
    vi.mocked(commandApi.listConversationMessages).mockImplementationOnce((_conversationId, options) => {
      historySignal = options?.signal;
      return new Promise((resolve) => { releaseHistory = resolve; });
    });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');
    await waitFor(() => expect(historySignal).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: '重命名 主要讨论' }));
    await userEvent.clear(screen.getByRole('textbox', { name: '重命名 Conversation' }));
    await userEvent.type(screen.getByRole('textbox', { name: '重命名 Conversation' }), 'Metadata only');
    await userEvent.keyboard('{Enter}');
    expect((await screen.findAllByText('Metadata only')).length).toBeGreaterThan(0);
    expect(historySignal?.aborted).toBe(false);

    await act(async () => releaseHistory({
      messages: [{
        id: 'late-message', commandId: 'old-command', role: 'assistant', content: 'Deferred history completed',
        sequence: 1, createdAt: checkpoint.createdAt,
      }],
      pendingInterrupt: null,
    }));
    expect(await screen.findByText('Deferred history completed')).toBeInTheDocument();
  });

  it('keeps a manual title overlay while taking activity and status from the reloaded base', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    const reloadedConversation: WorkflowConversation = {
      ...conversation,
      title: 'Agent refreshed title',
      titleSource: 'agent',
      isPrimary: false,
      status: 'initializing',
      updatedAt: '2027-01-02T00:00:00.000Z',
    };
    let routeRequests = 0;
    const model = defaultModel();
    model.override = (url, init) => {
      if (url === `/api/conversations/${conversation.id}` && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body)) as { title: string };
        return Promise.resolve(Response.json({
          ...conversation, title: input.title, titleSource: 'user',
        }));
      }
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) {
        routeRequests += 1;
        return Promise.resolve(Response.json(routeRequests === 1
          ? model.routeWorkspaces[route.id]
          : routeWorkspace({ conversations: [reloadedConversation] })));
      }
      return undefined;
    };
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');

    await userEvent.click(screen.getByRole('button', { name: '重命名 主要讨论' }));
    await userEvent.clear(screen.getByRole('textbox', { name: '重命名 Conversation' }));
    await userEvent.type(screen.getByRole('textbox', { name: '重命名 Conversation' }), 'Manual title lock');
    await userEvent.keyboard('{Enter}');
    expect((await screen.findAllByText('Manual title lock')).length).toBeGreaterThan(0);

    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'refresh workspace');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(routeRequests).toBeGreaterThan(1));
    expect((await screen.findAllByText('Manual title lock')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Agent refreshed title')).not.toBeInTheDocument();
    expect(screen.getByText(/主路线 · 初始化中/)).toBeInTheDocument();
    const reloadedActivity = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(reloadedConversation.updatedAt));
    expect(screen.getByText(reloadedActivity)).toBeInTheDocument();
  });

  it('carries a newer draft and later attachment through real App Command settlement', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    installApi(defaultModel());
    let releaseSuccess!: () => void;
    vi.mocked(commandApi.streamCommandEvents)
      .mockResolvedValueOnce({ lastEventId: 1, finished: { outcome: 'failed', code: 'WORKFLOW_UNAVAILABLE' } })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseSuccess = resolve; });
        return {
          lastEventId: 1,
          finished: {
            outcome: 'succeeded' as const,
            contextId: context.id,
            routeId: route.id,
            conversationId: conversation.id,
            checkpointId: checkpoint.id,
          },
        };
      });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');
    const input = screen.getByRole('textbox', { name: 'Workflow Input' });
    await userEvent.type(input, 'attempt A');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: '测试暂存附件' }));
    expect(await screen.findByText('owned.pdf')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await userEvent.clear(input);
    await userEvent.type(input, 'next draft B');
    await act(async () => releaseSuccess());

    await waitFor(() => expect(screen.getByRole('button', { name: '发送 Workflow Input' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('next draft B');
    expect(screen.getByText('owned.pdf')).toBeInTheDocument();
    expect(vi.mocked(commandApi.createWorkflowCommand).mock.calls[1]![0].attachmentIds).toEqual([]);
  });

  it('hands a retained virtual composer to the created real Conversation owner', async () => {
    let established = false;
    const model: ApiModel = { contexts: [], contextWorkspaces: {}, routeWorkspaces: {} };
    model.override = (url) => {
      if (url === '/api/contexts') {
        return Promise.resolve(Response.json({ contexts: established ? [context] : [] }));
      }
      if (url === `/api/contexts/${context.id}/workspace`) {
        return Promise.resolve(Response.json({ context, routes: [route] }));
      }
      if (url === `/api/routes/${route.id}/workspace`) {
        return Promise.resolve(Response.json(routeWorkspace()));
      }
      return undefined;
    };
    installApi(model);
    let releaseSuccess!: () => void;
    vi.mocked(commandApi.streamCommandEvents)
      .mockResolvedValueOnce({ lastEventId: 1, finished: { outcome: 'failed', code: 'WORKFLOW_UNAVAILABLE' } })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { releaseSuccess = resolve; });
        return {
          lastEventId: 1,
          finished: {
            outcome: 'succeeded' as const,
            contextId: context.id,
            routeId: route.id,
            conversationId: conversation.id,
            checkpointId: checkpoint.id,
          },
        };
      });
    render(<App manifest={manifest} user={user} />);
    const input = await screen.findByRole('textbox', { name: 'Workflow Input' });
    await userEvent.type(input, 'virtual attempt A');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: '测试暂存附件' }));
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await userEvent.clear(input);
    await userEvent.type(input, 'real owner draft B');
    established = true;
    await act(async () => releaseSuccess());

    await waitFor(() => expect(location.pathname).toContain(`/conversations/${conversation.id}`));
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('real owner draft B');
    expect(screen.getByLabelText('附件区')).toHaveTextContent(/owned\.pdf|已暂存附件 1/);
  });

  it('archives a non-current Conversation without navigating or aborting the current Command', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    const model = defaultModel([conversation, conversationB]);
    model.override = (url, init) => {
      if (url === `/api/conversations/${conversationB.id}` && init?.method === 'PATCH') {
        return Promise.resolve(Response.json({ ...conversationB, status: 'archived' }));
      }
      return undefined;
    };
    installApi(model);
    let streamSignal: AbortSignal | undefined;
    vi.mocked(commandApi.streamCommandEvents).mockImplementationOnce(async (_url, options) => {
      streamSignal = options.signal;
      await new Promise<void>(() => undefined);
      throw new Error('unreachable');
    });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), 'keep running');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    await waitFor(() => expect(streamSignal).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: '归档 第二讨论' }));
    await waitFor(() => expect(screen.queryByText('第二讨论')).not.toBeInTheDocument());
    expect(streamSignal?.aborted).toBe(false);
    expect(location.pathname).toBe(`/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    expect(screen.getByRole('button', { name: /^主要讨论 主路线/ })).toHaveAttribute('aria-current', 'page');
  });

  it('does not let a slow archive of the old current Conversation hijack a newer selection', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
    const model = defaultModel([conversation, conversationB]);
    model.override = (url, init) => {
      if (url === `/api/conversations/${conversation.id}` && init?.method === 'PATCH') {
        return archiveGate.then(() => Response.json({ ...conversation, status: 'archived' }));
      }
      return undefined;
    };
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');

    await userEvent.click(screen.getByRole('button', { name: '归档 主要讨论' }));
    await userEvent.click(screen.getByRole('button', { name: /^第二讨论 主路线/ }));
    await waitFor(() => expect(location.pathname).toContain(`/conversations/${conversationB.id}`));
    await act(async () => releaseArchive());

    await waitFor(() => expect(screen.queryByText('主要讨论')).not.toBeInTheDocument());
    expect(location.pathname).toContain(`/conversations/${conversationB.id}`);
    expect(screen.getByRole('button', { name: /^第二讨论 主路线/ })).toHaveAttribute('aria-current', 'page');
  });

  it('replaces an archived Conversation that becomes current again before its response', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
    const model = defaultModel([conversation, conversationB]);
    model.override = (url, init) => {
      if (url === `/api/conversations/${conversation.id}` && init?.method === 'PATCH') {
        return archiveGate.then(() => Response.json({ ...conversation, status: 'archived' }));
      }
      return undefined;
    };
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');

    await userEvent.click(screen.getByRole('button', { name: '归档 主要讨论' }));
    await userEvent.click(screen.getByRole('button', { name: /^第二讨论 主路线/ }));
    await waitFor(() => expect(location.pathname).toContain(`/conversations/${conversationB.id}`));
    await userEvent.click(screen.getByRole('button', { name: /^主要讨论 主路线/ }));
    await waitFor(() => expect(location.pathname).toContain(`/conversations/${conversation.id}`));
    await act(async () => releaseArchive());

    await waitFor(() => expect(screen.queryByText('主要讨论')).not.toBeInTheDocument());
    expect(location.pathname).toContain(`/conversations/${conversationB.id}`);
  });

  it('replaces a non-current archive target when it becomes current before the response', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
    const model = defaultModel([conversation, conversationB]);
    model.override = (url, init) => {
      if (url === `/api/conversations/${conversationB.id}` && init?.method === 'PATCH') {
        return archiveGate.then(() => Response.json({ ...conversationB, status: 'archived' }));
      }
      return undefined;
    };
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('主要讨论');

    await userEvent.click(screen.getByRole('button', { name: '归档 第二讨论' }));
    await userEvent.click(screen.getByRole('button', { name: /^第二讨论 主路线/ }));
    await waitFor(() => expect(location.pathname).toContain(`/conversations/${conversationB.id}`));
    await act(async () => releaseArchive());

    await waitFor(() => expect(screen.queryByText('第二讨论')).not.toBeInTheDocument());
    expect(location.pathname).toContain(`/conversations/${conversation.id}`);
  });

  it('remounts user-owned subtrees when identity changes while the next fetch is deferred', async () => {
    const userB = { id: 'user-2', email: 'other@example.test', username: 'other' };
    const contextB = { ...context, title: 'Project Beta' };
    const conversationBeta = { ...conversation, title: 'Beta Conversation' };
    const workspaceB = routeWorkspace({ context: contextB, conversations: [conversationBeta] });
    let activeIdentity: 'a' | 'b' = 'a';
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
    const respond = (value: unknown) => activeIdentity === 'a'
      ? Promise.resolve(Response.json(value))
      : bGate.then(() => Response.json(value));
    installApi({
      contexts: [], contextWorkspaces: {}, routeWorkspaces: {},
      override: (url) => {
        if (url === '/api/contexts') return respond({ contexts: [activeIdentity === 'a' ? context : contextB] });
        if (url === `/api/contexts/${context.id}/workspace`) {
          return respond({ context: activeIdentity === 'a' ? context : contextB, routes: [route] });
        }
        if (url === `/api/routes/${route.id}/workspace`) {
          return respond(activeIdentity === 'a' ? routeWorkspace() : workspaceB);
        }
        if (url === '/api/archive/conversations') {
          return respond({ conversations: [{
            id: activeIdentity === 'a' ? 'archive-a' : 'archive-b',
            title: activeIdentity === 'a' ? 'A private archive' : 'B private archive',
            messageCount: 1,
          }] });
        }
        return undefined;
      },
    });
    const view = render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');
    await userEvent.click(screen.getByRole('button', { name: '重命名 Project Alpha' }));
    await userEvent.clear(screen.getByRole('textbox', { name: '重命名 Context' }));
    await userEvent.type(screen.getByRole('textbox', { name: '重命名 Context' }), 'A secret rename');
    await userEvent.click(screen.getByRole('button', { name: '重命名 主要讨论' }));
    await userEvent.clear(screen.getByRole('textbox', { name: '重命名 Conversation' }));
    await userEvent.type(screen.getByRole('textbox', { name: '重命名 Conversation' }), 'A main Conversation secret');
    await userEvent.click(screen.getByRole('button', { name: '管理 Conversations' }));
    const drawer = screen.getByRole('dialog', { name: 'Conversation 管理' });
    await userEvent.click(within(drawer).getByRole('button', { name: '重命名 主要讨论' }));
    await userEvent.clear(within(drawer).getByRole('textbox', { name: '重命名 Conversation' }));
    await userEvent.type(
      within(drawer).getByRole('textbox', { name: '重命名 Conversation' }),
      'A drawer Conversation secret',
    );
    await userEvent.click(screen.getByRole('button', { name: '导入档案' }));
    expect(await screen.findByText('A private archive')).toBeInTheDocument();

    activeIdentity = 'b';
    view.rerender(<App manifest={manifest} user={userB} />);
    expect(screen.queryByText('Project Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('A private archive')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('A secret rename')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('A main Conversation secret')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('A drawer Conversation secret')).not.toBeInTheDocument();

    await act(async () => releaseB());
    expect((await screen.findAllByText('Project Beta')).length).toBeGreaterThan(0);
    expect(await screen.findByText('B private archive')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('A secret rename')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('A main Conversation secret')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('A drawer Conversation secret')).not.toBeInTheDocument();
  });

  it('ignores a Context create result from the previous user identity', async () => {
    const userB = { id: 'user-2', email: 'other@example.test', username: 'other' };
    const createdContext = { ...context, id: 'context-created-a', title: 'A deferred create' };
    const createdRoute = { ...route, id: 'route-created-a', contextId: createdContext.id };
    const createdCheckpoint = {
      ...checkpoint, id: 'checkpoint-created-a', contextId: createdContext.id, routeId: createdRoute.id,
    };
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const model = defaultModel();
    model.override = (url, init) => {
      if (url === '/api/contexts' && init?.method === 'POST') {
        return createGate.then(() => Response.json({
          context: createdContext,
          route: createdRoute,
          checkpoint: createdCheckpoint,
        }));
      }
      return undefined;
    };
    installApi(model);
    const view = render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');
    await userEvent.click(screen.getByRole('button', { name: '更多 Context 操作' }));
    await userEvent.click(screen.getByRole('button', { name: '新建 Context' }));
    await userEvent.type(screen.getByLabelText('Context 名称'), 'A deferred create');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));

    view.rerender(<App manifest={manifest} user={userB} />);
    await screen.findAllByText('Project Alpha');
    const userBLocation = location.pathname + location.search;
    await act(async () => releaseCreate());

    await waitFor(() => expect(location.pathname + location.search).toBe(userBLocation));
    expect(location.pathname).not.toContain(createdContext.id);
  });

  it('accepts a Context create result for the committed owner after a newer owner render is abandoned', async () => {
    const userB = { id: 'user-2', email: 'other@example.test', username: 'other' };
    const createdContext = { ...context, id: 'context-created-committed-a', title: 'A committed create' };
    const createdRoute = { ...route, id: 'route-created-committed-a', contextId: createdContext.id };
    const createdCheckpoint = {
      ...checkpoint,
      id: 'checkpoint-created-committed-a',
      contextId: createdContext.id,
      routeId: createdRoute.id,
    };
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const abandoned = new Promise<void>(() => undefined);
    let renderedAbandonedOwner = false;
    const model = defaultModel();
    model.override = (url, init) => {
      if (url === '/api/contexts' && init?.method === 'POST') {
        return createGate.then(() => Response.json({
          context: createdContext,
          route: createdRoute,
          checkpoint: createdCheckpoint,
        }));
      }
      return undefined;
    };
    installApi(model);

    function SuspendAfterApp({ suspend }: { suspend: boolean }) {
      if (suspend) {
        renderedAbandonedOwner = true;
        throw abandoned;
      }
      return null;
    }

    function ConcurrentOwnerHarness() {
      const [showUserB, setShowUserB] = useState(false);
      return <>
        <button type="button" onClick={() => {
          startTransition(() => setShowUserB(true));
        }}>尝试渲染 user B</button>
        <Suspense fallback={<p>user B fallback</p>}>
          <App manifest={manifest} user={showUserB ? userB : user} />
          <SuspendAfterApp suspend={showUserB} />
        </Suspense>
      </>;
    }

    render(<ConcurrentOwnerHarness />);
    await screen.findAllByText('Project Alpha');
    await userEvent.click(screen.getByRole('button', { name: '更多 Context 操作' }));
    await userEvent.click(screen.getByRole('button', { name: '新建 Context' }));
    await userEvent.type(screen.getByLabelText('Context 名称'), 'A committed create');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));

    await userEvent.click(screen.getByRole('button', { name: '尝试渲染 user B' }));
    await waitFor(() => expect(renderedAbandonedOwner).toBe(true));
    expect(screen.queryByText('user B fallback')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Context 名称')).toHaveValue('A committed create');

    await act(async () => releaseCreate());

    await waitFor(() => expect(location.pathname).toContain(createdContext.id));
  });

  it('composes the Context sidebar, Conversation axis, drawer and inspector', async () => {
    installApi(defaultModel());
    render(<App manifest={manifest} user={user} />);
    const contextSidebar = await screen.findByRole('complementary', { name: 'Context' });
    const conversationAxis = screen.getByRole('main');
    const inspector = screen.getByRole('complementary', { name: '工作空间检查器' });
    expect(conversationAxis).toHaveClass('conversation-axis');
    expect(contextSidebar.compareDocumentPosition(conversationAxis) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(conversationAxis.compareDocumentPosition(inspector) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(screen.queryByText('阶段讨论')).not.toBeInTheDocument();
    const manageTrigger = screen.getByRole('button', { name: '管理 Conversations' });
    await userEvent.click(manageTrigger);
    expect(screen.getByRole('dialog', { name: 'Conversation 管理' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Conversation 管理' })).not.toBeInTheDocument();
    expect(manageTrigger).toHaveFocus();
  });

  it('uses one inspector with the exact four tabs and mobile open/close semantics', async () => {
    installApi(defaultModel());
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '情景记忆', '用户记忆', '成果', '运行',
    ]);
    expect(screen.getByRole('tab', { name: '情景记忆' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('只作用于当前 Context，并为后续处理提供持续约束。')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Stage Projection' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '运行' }));
    expect(screen.getByText('当前没有 Stage Projection。')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /Stage|阶段/ })).not.toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: '打开记忆、成果与运行检查器' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-controls', 'workspace-inspector');
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const inspector = screen.getByRole('dialog', { name: '工作空间检查器' });
    expect(inspector).toHaveAttribute('aria-modal', 'true');
    expect(inspector).toHaveAttribute('data-mobile-open', 'true');
    expect(screen.getByRole('button', { name: '关闭记忆、成果与运行检查器' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    expect(screen.getByRole('complementary', { name: '工作空间检查器' }))
      .toHaveAttribute('data-mobile-open', 'false');
  });

  it('opens Contexts as a labelled mobile layer and restores focus after Escape', async () => {
    installApi(defaultModel());
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');

    const trigger = screen.getByRole('button', { name: '打开 Contexts' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-controls', 'context-mobile-layer');
    await userEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Contexts' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: '关闭 Contexts' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Contexts' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('defaults a new owner to Context memory without issuing the previous owner tab request', async () => {
    const fetchMock = installApi(defaultModel());
    const rendered = render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');
    await userEvent.click(screen.getByRole('tab', { name: '用户记忆' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) =>
      String(url) === '/api/memory?scope=user')).toBe(true));

    const requestCount = fetchMock.mock.calls.length;
    const userB = { id: 'user-2', email: 'other@example.test', username: 'other' };
    rendered.rerender(<App manifest={manifest} user={userB} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '情景记忆' }))
      .toHaveAttribute('aria-selected', 'true'));

    const newOwnerMemoryRequests = fetchMock.mock.calls.slice(requestCount)
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/memory?'));
    expect(newOwnerMemoryRequests).not.toContain('/api/memory?scope=user');
  });

  it('keeps user memory across Context navigation and isolates Context memory', async () => {
    const contextB: WorkflowContext = {
      ...context, id: 'context-b', title: 'Project Beta', updatedAt: '2026-07-19T00:00:00.000Z',
    };
    const routeB: WorkflowRoute = {
      ...route, id: 'route-b', contextId: contextB.id, name: 'Beta Route', headCheckpointId: 'checkpoint-b',
    };
    const checkpointB: WorkflowCheckpoint = {
      ...checkpoint, id: 'checkpoint-b', contextId: contextB.id, routeId: routeB.id,
    };
    const conversationBeta: WorkflowConversation = {
      ...conversation, id: 'conversation-beta', contextId: contextB.id, routeId: routeB.id, title: 'Beta Conversation',
    };
    const model = defaultModel();
    model.contexts = [context, contextB];
    model.contextWorkspaces[contextB.id] = { context: contextB, routes: [routeB] };
    model.routeWorkspaces[routeB.id] = routeWorkspace({
      context: contextB, route: routeB, headCheckpoint: checkpointB, conversations: [conversationBeta],
    });
    model.override = (url) => {
      const base = {
        id: 'memory-shared', value: 'value', status: 'active', version: 1,
        source: { kind: 'workflow' }, evidence: [], impactScope: { contextIds: 'all' },
        createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
      };
      if (url === '/api/memory?scope=user') return Promise.resolve(Response.json({ memories: [{
        ...base, scope: 'user', contextId: null, key: 'cross-context-taste',
      }] }));
      if (url === `/api/memory?scope=context&context=${context.id}`) return Promise.resolve(Response.json({ memories: [{
        ...base, id: 'memory-a', scope: 'context', contextId: context.id, key: 'alpha-constraint',
      }] }));
      if (url === `/api/memory?scope=context&context=${contextB.id}`) return Promise.resolve(Response.json({ memories: [{
        ...base, id: 'memory-b', scope: 'context', contextId: contextB.id, key: 'beta-constraint',
      }] }));
      return undefined;
    };
    const fetchMock = installApi(model);
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}`);
    render(<App manifest={manifest} user={user} />);
    expect(await screen.findByText('alpha-constraint')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '用户记忆' }));
    expect(await screen.findByText('cross-context-taste')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Project Beta 打开/ }));
    expect(await screen.findByRole('heading', { name: 'Project Beta' })).toBeInTheDocument();
    expect(screen.getByText('cross-context-taste')).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/memory?scope=user')).toHaveLength(1);

    await userEvent.click(screen.getByRole('tab', { name: '情景记忆' }));
    expect(await screen.findByText('beta-constraint')).toBeInTheDocument();
    expect(screen.queryByText('alpha-constraint')).not.toBeInTheDocument();
  });

  it('shows snapshot Stage Projection only in Run and preserves Input on exact Checkpoint navigation', async () => {
    const projectionCheckpoint: WorkflowCheckpoint = {
      ...checkpoint,
      id: 'checkpoint-projection',
      version: 1,
    };
    const projection: StageProjectionSnapshot = {
      revision: 'dynamic-v7',
      items: Array.from({ length: 7 }, (_, index) => ({
        key: `dynamic-${index + 1}`,
        label: `动态运行项 ${index + 1}`,
        status: index < 2 ? 'completed' : index === 2 ? 'active' : 'not_started',
        ...(index === 2 ? { checkpointId: projectionCheckpoint.id } : {}),
      })),
    };
    const model = defaultModel();
    const projectedHead = {
      ...checkpoint,
      snapshot: { ...checkpoint.snapshot, stageProjection: projection },
    };
    model.routeWorkspaces[route.id] = routeWorkspace({ headCheckpoint: projectedHead });
    model.override = (url) => url === `/api/routes/${route.id}/workspace?checkpoint=${projectionCheckpoint.id}`
      ? Promise.resolve(Response.json(routeWorkspace({
        selectedCheckpoint: projectionCheckpoint,
        stageProjection: projection,
      })))
      : undefined;
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');
    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), '保留这段未发送输入');

    expect(screen.queryByText('动态运行项 3')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '运行' }));
    expect(screen.getByText('已完成 2 / 7')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看全部 7 项' }));
    await userEvent.click(screen.getByRole('button', { name: /动态运行项 3.*checkpoint-projection/i }));

    await waitFor(() => expect(location.search).toBe('?checkpoint=checkpoint-projection'));
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveValue('保留这段未发送输入');
    expect(commandApi.createWorkflowCommand).not.toHaveBeenCalled();
  });

  it('prefers the selected historical Checkpoint projection and summarizes current artifacts', async () => {
    const historical: WorkflowCheckpoint = {
      ...checkpoint,
      id: 'checkpoint-old',
      version: 1,
      snapshot: {
        ...checkpoint.snapshot,
        artifacts: [{
          id: 'artifact/selected', stage_key: null, filename: 'current-report.pdf',
          media_type: 'application/pdf', byte_size: 1024, sha256: 'a'.repeat(64),
          created_at: '2026-07-18T00:00:00.000Z',
        }],
        stageProjection: {
          revision: 'historical-v1',
          items: [{ key: 'old', label: '历史投影项', status: 'paused_without_web_change' }],
        },
      },
    };
    const artifact: CheckpointArtifact = {
      id: 'artifact-workspace-decoy', stage_key: null, filename: 'workspace-decoy.pdf', media_type: 'application/pdf',
      byte_size: 1024, sha256: 'a'.repeat(64), created_at: '2026-07-18T00:00:00.000Z',
    };
    const model = defaultModel();
    model.routeWorkspaces[route.id] = routeWorkspace({
      selectedCheckpoint: historical,
      artifacts: [artifact],
      stageProjection: {
        revision: 'head-v7',
        items: Array.from({ length: 7 }, (_, index) => ({
          key: `head-${index}`, label: `头部投影 ${index}`, status: 'completed',
        })),
      },
    });
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}?checkpoint=${historical.id}`);
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');
    await userEvent.click(screen.getByRole('tab', { name: '运行' }));
    expect(screen.getByText('历史投影项')).toBeInTheDocument();
    expect(screen.getByText('paused_without_web_change')).toHaveAttribute('data-status', 'neutral');
    expect(screen.queryByText(/头部投影/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '成果' }));
    const conversationRegion = document.querySelector('.conversation') as HTMLElement;
    const inspectorPanel = screen.getByRole('tabpanel');
    expect(within(conversationRegion).getByRole('link', { name: /current-report\.pdf/ }))
      .toHaveAttribute('href', '/api/assets/artifact/artifact%2Fselected/download');
    expect(within(inspectorPanel).getByRole('link', { name: /current-report\.pdf/ }))
      .toHaveAttribute('href', '/api/assets/artifact/artifact%2Fselected/download');
    expect(screen.getAllByRole('link', { name: /current-report\.pdf/ })).toHaveLength(2);
    expect(screen.queryByText('workspace-decoy.pdf')).not.toBeInTheDocument();
    expect(screen.getByText('1 个成果')).toBeInTheDocument();
  });

  it('does not fall back to a head projection when the selected historical Checkpoint has none', async () => {
    const historicalWithoutProjection: WorkflowCheckpoint = {
      ...checkpoint,
      id: 'checkpoint-without-projection',
      version: 1,
      snapshot: { ...checkpoint.snapshot },
    };
    const model = defaultModel();
    model.routeWorkspaces[route.id] = routeWorkspace({
      selectedCheckpoint: historicalWithoutProjection,
      stageProjection: {
        revision: 'head-decoy',
        items: [{ key: 'decoy', label: '不属于历史版本的投影', status: 'active' }],
      },
    });
    history.replaceState(
      {},
      '',
      `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}?checkpoint=${historicalWithoutProjection.id}`,
    );
    installApi(model);
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');
    await userEvent.click(screen.getByRole('tab', { name: '运行' }));

    expect(screen.getByText('当前没有 Stage Projection。')).toBeInTheDocument();
    expect(screen.queryByText('不属于历史版本的投影')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Stage Projection' })).not.toBeInTheDocument();
  });

  it('keeps a memory confirmation Interrupt in the Conversation while the inspector is present', async () => {
    vi.mocked(commandApi.listConversationMessages).mockResolvedValueOnce({
      messages: [],
      pendingInterrupt: { id: 'memory-conflict', prompt: '这条高影响记忆与现有事实冲突，请确认。' },
    });
    installApi(defaultModel());
    render(<App manifest={manifest} user={user} />);

    expect(await screen.findByText('这条高影响记忆与现有事实冲突，请确认。')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Interrupt 回复' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: '工作空间检查器' })).toBeInTheDocument();
  });

  it('browses exact Checkpoints and returns to head without creating a Command or Route', async () => {
    const archivedArtifact: CheckpointArtifact = {
      id: 'artifact/archive 1', stage_key: null, filename: '历史成果.pdf', media_type: 'application/pdf',
      byte_size: 3072, sha256: 'c'.repeat(64), created_at: '2026-07-17T01:00:00.000Z',
    };
    const historical: WorkflowCheckpoint = {
      ...checkpoint,
      id: 'checkpoint-archive-old',
      parentCheckpointId: 'checkpoint-bootstrap',
      version: 1,
      snapshot: {
        workflowState: { exactArchiveMarker: 'history-state-only' },
        stageProjection: {
          revision: 'archive-revision-1',
          items: [{ key: 'old', label: '历史投影', status: 'waiting', checkpointId: 'checkpoint-archive-old' }],
        },
        memoryReferences: [{ memoryId: 'memory-archive', version: 4 }],
        artifacts: [archivedArtifact],
      },
    };
    const currentWorkspace = {
      ...routeWorkspace(),
      checkpoints: [checkpoint, historical],
    };
    const historicalWorkspace = {
      ...routeWorkspace({ selectedCheckpoint: historical, headCheckpoint: checkpoint }),
      checkpoints: [checkpoint, historical],
    };
    const model = defaultModel();
    model.routeWorkspaces[route.id] = currentWorkspace;
    model.override = (url, init) => {
      if (url === `/api/routes/${route.id}/workspace?checkpoint=${historical.id}`) {
        return Promise.resolve(Response.json(historicalWorkspace));
      }
      if (url === `/api/conversations/${conversation.id}` && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body)) as { title: string };
        return Promise.resolve(Response.json({ ...conversation, title: input.title, titleSource: 'user' }));
      }
      if (url === `/api/contexts/${context.id}` && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body)) as { title: string };
        return Promise.resolve(Response.json({ ...context, title: input.title }));
      }
      return undefined;
    };
    const fetchMock = installApi(model);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<App manifest={manifest} user={user} />);
    await screen.findAllByText('Project Alpha');

    await userEvent.click(screen.getByRole('button', { name: '打开版本归档' }));
    let archive = screen.getByRole('dialog', { name: '版本归档' });
    await userEvent.click(within(archive).getByRole('button', { name: /版本 01/ }));
    expect(within(archive).getByText(/history-state-only/)).toBeInTheDocument();
    expect(within(archive).getByText('memory-archive')).toBeInTheDocument();
    const download = within(archive).getByRole('link', { name: '下载历史成果.pdf' });
    expect(download).toHaveAttribute('href', '/api/assets/artifact/artifact%2Farchive%201/download');
    download.addEventListener('click', (event) => event.preventDefault());
    await userEvent.click(download);
    await userEvent.click(within(archive).getByRole('button', { name: '复制历史成果.pdf链接' }));
    expect(writeText).toHaveBeenCalledWith('/api/assets/artifact/artifact%2Farchive%201/download');
    await userEvent.click(within(archive).getByRole('button', { name: '关闭版本归档' }));
    expect(screen.queryByRole('dialog', { name: '版本归档' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '打开版本归档' }));
    archive = screen.getByRole('dialog', { name: '版本归档' });
    await userEvent.click(within(archive).getByRole('button', { name: /版本 01/ }));
    await userEvent.click(within(archive).getByRole('button', { name: '在此版本继续' }));
    await waitFor(() => expect(location.search).toBe(`?checkpoint=${historical.id}`));
    expect(await screen.findByRole('note')).toHaveTextContent(
      '正在查看历史投影。此版本不可修改；从这里输入会创建一条新时间线，原路线不受影响。',
    );
    expect(screen.getByRole('textbox', { name: 'Workflow Input' })).toHaveFocus();
    expect(screen.queryByLabelText(/路线名称|Conversation 名称/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '重命名 主要讨论' }));
    await userEvent.clear(screen.getByRole('textbox', { name: '重命名 Conversation' }));
    await userEvent.type(screen.getByRole('textbox', { name: '重命名 Conversation' }), '历史浏览讨论');
    await userEvent.keyboard('{Enter}');
    await screen.findAllByText('历史浏览讨论');
    await userEvent.click(screen.getByRole('button', { name: '重命名 Project Alpha' }));
    await userEvent.clear(screen.getByRole('textbox', { name: '重命名 Context' }));
    await userEvent.type(screen.getByRole('textbox', { name: '重命名 Context' }), '历史浏览 Context');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: '历史浏览 Context' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '打开版本归档' }));
    archive = screen.getByRole('dialog', { name: '版本归档' });
    await userEvent.click(within(archive).getByRole('button', { name: /版本 02/ }));
    await userEvent.click(within(archive).getByRole('button', { name: '返回当前版本' }));
    await waitFor(() => expect(location.search).toBe(''));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(commandApi.createWorkflowCommand).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('branches only when historical Workflow Input succeeds and shows source provenance', async () => {
    const historical: WorkflowCheckpoint = {
      ...checkpoint,
      id: 'checkpoint-branch-source',
      version: 1,
      snapshot: { ...checkpoint.snapshot, workflowState: { source: 'immutable' } },
    };
    const branchRoute: WorkflowRoute = {
      ...route,
      id: 'route-equal-branch',
      originCheckpointId: historical.id,
      origin: {
        routeId: route.id,
        routeName: route.name,
        version: historical.version,
        stageKey: historical.stageKey,
      },
      headCheckpointId: 'checkpoint-equal-branch',
    };
    const branchCheckpoint: WorkflowCheckpoint = {
      ...checkpoint,
      id: branchRoute.headCheckpointId,
      routeId: branchRoute.id,
      parentCheckpointId: 'checkpoint-equal-bootstrap',
      version: 1,
    };
    const branchConversation: WorkflowConversation = {
      ...conversation,
      id: 'conversation-equal-branch',
      routeId: branchRoute.id,
      title: '新时间线 Conversation',
    };
    const sourceWorkspace = {
      ...routeWorkspace({ selectedCheckpoint: historical, headCheckpoint: checkpoint }),
      checkpoints: [checkpoint, historical],
    };
    const model = defaultModel();
    model.contextWorkspaces[context.id] = { context, routes: [route, branchRoute] };
    model.routeWorkspaces[route.id] = sourceWorkspace;
    model.routeWorkspaces[branchRoute.id] = routeWorkspace({
      route: branchRoute,
      selectedCheckpoint: branchCheckpoint,
      headCheckpoint: branchCheckpoint,
      conversations: [branchConversation],
    });
    history.replaceState(
      {},
      '',
      `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}?checkpoint=${historical.id}`,
    );
    const fetchMock = installApi(model);
    vi.mocked(commandApi.streamCommandEvents).mockResolvedValueOnce({
      lastEventId: 1,
      finished: {
        outcome: 'succeeded',
        contextId: context.id,
        routeId: branchRoute.id,
        conversationId: branchConversation.id,
        checkpointId: branchCheckpoint.id,
      },
    });
    render(<App manifest={manifest} user={user} />);
    expect(await screen.findByRole('note')).toHaveTextContent(
      '正在查看历史投影。此版本不可修改；从这里输入会创建一条新时间线，原路线不受影响。',
    );
    expect(screen.queryByLabelText(/路线名称|Conversation 名称/)).not.toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox', { name: 'Workflow Input' }), '从准确历史继续');
    await userEvent.click(screen.getByRole('button', { name: '发送 Workflow Input' }));
    expect(commandApi.createWorkflowCommand).toHaveBeenCalledWith(expect.objectContaining({
      contextId: context.id,
      routeId: route.id,
      conversationId: conversation.id,
      baseCheckpointId: historical.id,
      expectedCheckpointVersion: historical.version,
      input: { type: 'message', content: '从准确历史继续' },
    }), expect.anything());

    await waitFor(() => expect(location.pathname).toBe(
      `/contexts/${context.id}/routes/${branchRoute.id}/conversations/${branchConversation.id}`,
    ));
    await waitFor(() => expect(location.search).toBe(''));
    expect(await screen.findByText(`来源 Checkpoint ${historical.id}`)).toBeInTheDocument();
    expect(screen.getByText(`${route.name} · 版本 01`)).toBeInTheDocument();
    expect(screen.queryByLabelText(/路线名称|Conversation 名称/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('shows exact historical memory versions in both scopes without loading or mutating current memory', async () => {
    const historicalContextMemory: MemoryItem = {
      id: 'memory-history-context',
      scope: 'context',
      contextId: context.id,
      key: 'historical-context-goal',
      value: { outcome: 'checkpoint-v4' },
      status: 'active',
      version: 4,
      source: { kind: 'workflow', commandId: 'command-history' },
      evidence: [],
      impactScope: { contextIds: [context.id] },
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T01:00:00.000Z',
    };
    const currentContextMemory: MemoryItem = {
      ...historicalContextMemory,
      value: { outcome: 'current-v9' },
      version: 9,
    };
    const historicalUserMemory: MemoryItem = {
      ...historicalContextMemory,
      id: 'memory-history-user',
      scope: 'user',
      contextId: null,
      key: 'historical-user-taste',
      value: { tone: 'direct' },
      version: 2,
      impactScope: { contextIds: 'all' },
    };
    const historical: WorkflowCheckpoint = {
      ...checkpoint,
      id: 'checkpoint-memory-history',
      version: 1,
      snapshot: {
        ...checkpoint.snapshot,
        memoryReferences: [
          { memoryId: historicalContextMemory.id, version: historicalContextMemory.version },
          { memoryId: historicalUserMemory.id, version: historicalUserMemory.version },
        ],
      },
    };
    const model = defaultModel();
    model.routeWorkspaces[route.id] = routeWorkspace({
      selectedCheckpoint: historical,
      headCheckpoint: checkpoint,
    });
    model.override = (url, init) => {
      if (url === `/api/memory/${historicalContextMemory.id}/versions`) {
        return Promise.resolve(Response.json({ versions: [currentContextMemory, historicalContextMemory] }));
      }
      if (url === `/api/memory/${historicalUserMemory.id}/versions`) {
        return Promise.resolve(Response.json({ versions: [historicalUserMemory] }));
      }
      if (url.startsWith('/api/memory?')) {
        return Promise.resolve(Response.json({ memories: [currentContextMemory] }));
      }
      if (init?.method === 'PATCH' || init?.method === 'DELETE') {
        return Promise.resolve(Response.json({ error: { code: 'HISTORICAL_WRITE' } }, { status: 500 }));
      }
      return undefined;
    };
    history.replaceState(
      {},
      '',
      `/contexts/${context.id}/routes/${route.id}/conversations/${conversation.id}?checkpoint=${historical.id}`,
    );
    const fetchMock = installApi(model);

    render(<App manifest={manifest} user={user} />);

    expect(await screen.findByText('historical-context-goal')).toBeInTheDocument();
    expect(screen.getByText(/"outcome": "checkpoint-v4"/)).toBeInTheDocument();
    expect(screen.getByText('版本 4')).toBeInTheDocument();
    expect(screen.queryByText(/current-v9/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /修正 historical-context-goal|使 historical-context-goal 失效/ }))
      .not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '用户记忆' }));
    expect(await screen.findByText('historical-user-taste')).toBeInTheDocument();
    expect(screen.getByText(/"tone": "direct"/)).toBeInTheDocument();
    expect(screen.getByText('版本 2')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/memory?'))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH' || init?.method === 'DELETE'))
      .toBe(false);
  });
});
