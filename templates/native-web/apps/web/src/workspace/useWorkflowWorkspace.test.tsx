import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ContextWorkspace,
  RouteWorkspace,
  WorkflowCheckpoint,
  WorkflowContext,
  WorkflowConversation,
  WorkflowRoute,
} from '../domain/api';
import {
  formatWorkspaceLocation,
  parseWorkspaceLocation,
  useWorkflowWorkspace,
} from './useWorkflowWorkspace';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  history.replaceState({}, '', '/');
});

const checkpoint = (id: string, routeId: string, version: number): WorkflowCheckpoint => ({
  id,
  contextId: 'context-a',
  routeId,
  parentCheckpointId: null,
  version,
  stageKey: null,
  reason: version === 0 ? 'bootstrap' : 'workflow_action',
  snapshot: { workflowState: {}, memoryReferences: [], artifacts: [] },
  createdAt: `2026-07-1${version}T00:00:00.000Z`,
});

const context = (id: string, updatedAt: string): WorkflowContext => ({
  id,
  title: id,
  status: 'active',
  createdAt: updatedAt,
  updatedAt,
});

const route = (id: string, contextId: string, updatedAt: string): WorkflowRoute => ({
  id,
  contextId,
  name: id,
  originCheckpointId: null,
  headCheckpointId: `${id}-head`,
  createdAt: updatedAt,
  updatedAt,
});

const conversation = (
  id: string,
  routeId: string,
  options: { primary?: boolean; updatedAt?: string } = {},
): WorkflowConversation => ({
  id,
  contextId: 'context-a',
  routeId,
  title: id,
  titleSource: 'agent',
  isPrimary: options.primary ?? false,
  status: 'active',
  createdAt: options.updatedAt ?? '2026-07-17T00:00:00.000Z',
  updatedAt: options.updatedAt ?? '2026-07-17T00:00:00.000Z',
});

interface Model {
  contexts: WorkflowContext[];
  contextWorkspaces: Record<string, ContextWorkspace>;
  routeWorkspaces: Record<string, RouteWorkspace>;
}

function installApi(model: Model, overrides: Record<string, () => Promise<Response>> = {}) {
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    const override = overrides[url];
    if (override) return override();
    if (url === '/api/contexts') return Promise.resolve(Response.json({ contexts: model.contexts }));
    const contextMatch = /^\/api\/contexts\/([^/]+)\/workspace$/.exec(url);
    if (contextMatch) {
      const value = model.contextWorkspaces[decodeURIComponent(contextMatch[1]!)];
      return Promise.resolve(value ? Response.json(value) : Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
    }
    const routeMatch = /^\/api\/routes\/([^/?]+)\/workspace(?:\?checkpoint=([^&]+))?$/.exec(url);
    if (routeMatch) {
      const value = model.routeWorkspaces[decodeURIComponent(routeMatch[1]!)];
      if (!value) return Promise.resolve(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
      const requestedCheckpoint = routeMatch[2] && decodeURIComponent(routeMatch[2]);
      if (requestedCheckpoint && !value.checkpoints.some(({ id }) => id === requestedCheckpoint)) {
        return Promise.resolve(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
      }
      if (!requestedCheckpoint) return Promise.resolve(Response.json(value));
      const selectedCheckpoint = value.checkpoints.find(({ id }) => id === requestedCheckpoint)!;
      return Promise.resolve(Response.json({
        ...value,
        selectedCheckpoint,
        isHistorical: selectedCheckpoint.id !== value.headCheckpoint.id,
      }));
    }
    return Promise.resolve(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function populatedModel(options: { conversations?: WorkflowConversation[] } = {}): Model {
  const contextA = context('context-a', '2026-07-18T00:00:00.000Z');
  const routeA = route('route-a', contextA.id, '2026-07-18T00:00:00.000Z');
  const head = checkpoint('checkpoint-head', routeA.id, 2);
  const old = checkpoint('checkpoint-old', routeA.id, 1);
  return {
    contexts: [contextA],
    contextWorkspaces: { [contextA.id]: { context: contextA, routes: [routeA] } },
    routeWorkspaces: {
      [routeA.id]: {
        context: contextA,
        route: routeA,
        checkpoints: [head, old],
        conversations: options.conversations ?? [conversation('conversation-primary', routeA.id, { primary: true })],
        selectedCheckpoint: head,
        headCheckpoint: head,
        isHistorical: false,
        artifacts: [],
      },
    },
  };
}

describe('Stage-free workspace locations', () => {
  it('round-trips only Context, Route, Conversation, and Checkpoint IDs', () => {
    const selection = {
      contextId: 'context / a',
      routeId: 'route / a',
      conversationId: 'conversation / a',
      checkpointId: 'checkpoint / a',
    };

    const path = formatWorkspaceLocation(selection);

    expect(path).toBe('/contexts/context%20%2F%20a/routes/route%20%2F%20a/conversations/conversation%20%2F%20a?checkpoint=checkpoint%20%2F%20a');
    expect(parseWorkspaceLocation(path)).toEqual(selection);
    expect(path).not.toMatch(/\/stages\/|[?&]stage=/);
    expect(parseWorkspaceLocation('/contexts/c/routes/r/stages/discover?stage=discover')).toEqual({});
  });
});

describe('useWorkflowWorkspace', () => {
  it('restores the zero-Context draft and retains draft plus staged attachment IDs after failure', async () => {
    installApi({ contexts: [], contextWorkspaces: {}, routeWorkspaces: {} });
    const first = renderHook(() => useWorkflowWorkspace({ productId: 'demo', userId: 'user-a' }));
    await waitFor(() => expect(first.result.current.phase).toBe('empty'));

    act(() => {
      first.result.current.setDraft('retry this');
      first.result.current.setAttachmentIds(['attachment-a']);
    });
    await act(async () => {
      await first.result.current.settleCommand({ outcome: 'failed', code: 'WORKFLOW_FAILED' });
    });

    expect(first.result.current.draft).toBe('retry this');
    expect(first.result.current.attachmentIds).toEqual(['attachment-a']);
    first.unmount();

    const restored = renderHook(() => useWorkflowWorkspace({ productId: 'demo', userId: 'user-a' }));
    await waitFor(() => expect(restored.result.current.phase).toBe('empty'));
    expect(restored.result.current.draft).toBe('retry this');
    expect(restored.result.current.selection).toEqual({ virtualConversationId: 'virtual:start' });
  });

  it('replaces inaccessible deep links with the newest active Context/Route and primary Conversation', async () => {
    const model = populatedModel();
    const older = context('context-old', '2026-07-17T00:00:00.000Z');
    model.contexts.push(older);
    model.contextWorkspaces[older.id] = { context: older, routes: [] };
    history.replaceState({}, '', '/contexts/missing/routes/missing/conversations/missing?checkpoint=missing');
    installApi(model);
    const replaceSpy = vi.spyOn(history, 'replaceState');

    const { result } = renderHook(() => useWorkflowWorkspace({ productId: 'demo', userId: 'user-a' }));

    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.selection).toEqual({
      contextId: 'context-a',
      routeId: 'route-a',
      conversationId: 'conversation-primary',
      checkpointId: 'checkpoint-head',
    });
    expect(location.pathname + location.search).toBe('/contexts/context-a/routes/route-a/conversations/conversation-primary');
    expect(replaceSpy).toHaveBeenCalled();
  });

  it('falls back from a missing Checkpoint but surfaces service failures', async () => {
    const model = populatedModel();
    history.replaceState({}, '', '/contexts/context-a/routes/route-a?checkpoint=checkpoint-missing');
    installApi(model, {
      '/api/routes/route-a/workspace?checkpoint=checkpoint-missing': async () =>
        Response.json({ error: { code: 'INVALID_REQUEST' } }, { status: 400 }),
    });
    const missing = renderHook(() => useWorkflowWorkspace({ productId: 'demo', userId: 'user-a' }));

    await waitFor(() => expect(missing.result.current.phase).toBe('ready'));
    expect(missing.result.current.selection.checkpointId).toBe('checkpoint-head');
    expect(location.pathname + location.search).toBe(
      '/contexts/context-a/routes/route-a/conversations/conversation-primary',
    );
    missing.unmount();

    history.replaceState({}, '', '/contexts/context-a/routes/route-a?checkpoint=checkpoint-broken');
    installApi(model, {
      '/api/routes/route-a/workspace?checkpoint=checkpoint-broken': async () =>
        Response.json({ error: { code: 'WORKSPACE_UNAVAILABLE' } }, { status: 503 }),
    });
    const broken = renderHook(() => useWorkflowWorkspace({ productId: 'demo', userId: 'user-a' }));

    await waitFor(() => expect(broken.result.current.phase).toBe('error'));
    expect(location.search).toBe('?checkpoint=checkpoint-broken');
  });

  it('reacts to back/forward popstate and ignores an older navigation generation', async () => {
    const model = populatedModel();
    const routeSlow = route('route-slow', 'context-a', '2026-07-17T00:00:00.000Z');
    const slowHead = checkpoint('slow-head', routeSlow.id, 1);
    const slowWorkspace: RouteWorkspace = {
      ...model.routeWorkspaces['route-a']!,
      route: routeSlow,
      checkpoints: [slowHead],
      selectedCheckpoint: slowHead,
      headCheckpoint: slowHead,
      conversations: [conversation('conversation-slow', routeSlow.id, { primary: true })],
    };
    model.contextWorkspaces['context-a']!.routes.push(routeSlow);
    model.routeWorkspaces[routeSlow.id] = slowWorkspace;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    installApi(model, {
      '/api/routes/route-slow/workspace': async () => {
        await slowGate;
        return Response.json(slowWorkspace);
      },
    });
    history.replaceState({}, '', '/contexts/context-a/routes/route-slow/conversations/conversation-slow');
    const { result } = renderHook(() => useWorkflowWorkspace({ productId: 'demo', userId: 'user-a' }));

    await waitFor(() => expect(result.current.phase).toBe('loading'));
    history.pushState({}, '', '/contexts/context-a/routes/route-a/conversations/conversation-primary');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await waitFor(() => expect(result.current.selection.routeId).toBe('route-a'));

    releaseSlow();
    await act(async () => { await slowGate; });
    expect(result.current.selection.routeId).toBe('route-a');
    expect(result.current.selection.conversationId).toBe('conversation-primary');
  });

  it('replaces inaccessible popstate locations without adding history for a valid location', async () => {
    const fetchMock = installApi(populatedModel());
    const { result } = renderHook(() => useWorkflowWorkspace({ productId: 'demo', userId: 'user-a' }));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    const replaceSpy = vi.spyOn(history, 'replaceState');
    const pushSpy = vi.spyOn(history, 'pushState');
    const canonical = '/contexts/context-a/routes/route-a/conversations/conversation-primary';

    for (const inaccessible of [
      '/contexts/missing/routes/missing/conversations/missing',
      '/contexts/context-a/routes/missing/conversations/missing',
      '/contexts/context-a/routes/route-a/conversations/missing',
      '/contexts/context-a/routes/route-a/conversations/conversation-primary?checkpoint=missing',
    ]) {
      history.pushState({}, '', inaccessible);
      replaceSpy.mockClear();
      pushSpy.mockClear();
      act(() => window.dispatchEvent(new PopStateEvent('popstate')));
      await waitFor(() => expect(location.pathname + location.search).toBe(canonical));
      expect(replaceSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy).not.toHaveBeenCalled();
    }

    history.pushState({}, '', canonical);
    replaceSpy.mockClear();
    pushSpy.mockClear();
    const requestCount = fetchMock.mock.calls.length;
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(requestCount + 3));
    expect(result.current.phase).toBe('ready');
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('provides virtual Conversations immediately and isolates their drafts', async () => {
    installApi(populatedModel({ conversations: [] }));
    const ids = ['virtual:new:a', 'virtual:new:b'];
    const { result } = renderHook(() => useWorkflowWorkspace({
      productId: 'demo',
      userId: 'user-a',
      createVirtualConversationId: () => ids.shift()!,
    }));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.selection.virtualConversationId).toBe('virtual:primary:route-a');

    act(() => result.current.setDraft('primary draft'));
    act(() => result.current.startVirtualConversation());
    expect(result.current.selection.virtualConversationId).toBe('virtual:new:a');
    expect(result.current.draft).toBe('');
    act(() => result.current.setDraft('new draft'));
    act(() => result.current.selectVirtualConversation('virtual:primary:route-a'));

    expect(result.current.draft).toBe('primary draft');
  });

  it('uses a route-only canonical URL for an explicitly selected virtual Conversation', async () => {
    installApi(populatedModel());
    const { result } = renderHook(() => useWorkflowWorkspace({ productId: 'demo', userId: 'user-a' }));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    act(() => result.current.selectVirtualConversation('virtual:manual'));

    expect(result.current.selection).toMatchObject({
      contextId: 'context-a',
      routeId: 'route-a',
      virtualConversationId: 'virtual:manual',
    });
    expect(location.pathname + location.search).toBe('/contexts/context-a/routes/route-a');
    expect(location.href).not.toMatch(/\/stages\/|[?&]stage=/);
  });

  it('round-trips virtual Conversations through history state and preserves historical Checkpoints', async () => {
    const model = populatedModel();
    installApi(model);
    const { result } = renderHook(() => useWorkflowWorkspace({ productId: 'demo', userId: 'user-a' }));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    await act(async () => { await result.current.selectCheckpoint('checkpoint-old'); });
    await waitFor(() => expect(result.current.workspace?.isHistorical).toBe(true));
    const pushSpy = vi.spyOn(history, 'pushState');

    act(() => result.current.selectVirtualConversation('virtual:history:a'));
    act(() => result.current.selectVirtualConversation('virtual:history:b'));

    expect(location.pathname + location.search).toBe(
      '/contexts/context-a/routes/route-a?checkpoint=checkpoint-old',
    );
    expect(pushSpy).toHaveBeenCalledTimes(2);
    const stateA = pushSpy.mock.calls[0]![0];
    const stateB = pushSpy.mock.calls[1]![0];
    expect(stateA).toEqual({
      polarNativeWorkflow: {
        version: 1,
        productId: 'demo',
        userId: 'user-a',
        virtualConversationId: 'virtual:history:a',
      },
    });
    expect(stateB).toEqual({
      polarNativeWorkflow: {
        version: 1,
        productId: 'demo',
        userId: 'user-a',
        virtualConversationId: 'virtual:history:b',
      },
    });

    history.replaceState(stateA, '', location.pathname + location.search);
    act(() => window.dispatchEvent(new PopStateEvent('popstate', { state: stateA })));
    await waitFor(() => expect(result.current.selection.virtualConversationId).toBe('virtual:history:a'));
    expect(result.current.workspace?.isHistorical).toBe(true);
    expect(result.current.selection.conversationId).toBeUndefined();

    history.replaceState(stateB, '', location.pathname + location.search);
    act(() => window.dispatchEvent(new PopStateEvent('popstate', { state: stateB })));
    await waitFor(() => expect(result.current.selection.virtualConversationId).toBe('virtual:history:b'));
    expect(result.current.workspace?.isHistorical).toBe(true);
  });

  it('keeps a newer virtual Conversation when an older Checkpoint request resolves last', async () => {
    const model = populatedModel();
    const current = model.routeWorkspaces['route-a']!;
    const historical = current.checkpoints.find(({ id }) => id === 'checkpoint-old')!;
    let checkpointRequested = false;
    let releaseCheckpoint!: () => void;
    const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    installApi(model, {
      '/api/routes/route-a/workspace?checkpoint=checkpoint-old': async () => {
        checkpointRequested = true;
        await checkpointGate;
        return Response.json({
          ...current,
          selectedCheckpoint: historical,
          isHistorical: true,
        });
      },
    });
    const { result } = renderHook(() => useWorkflowWorkspace({
      productId: 'demo',
      userId: 'user-a',
      createVirtualConversationId: () => 'virtual:newer',
    }));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    let olderNavigation!: Promise<void>;
    act(() => {
      olderNavigation = result.current.selectCheckpoint('checkpoint-old');
    });
    await waitFor(() => expect(checkpointRequested).toBe(true));
    expect(result.current.phase).toBe('loading');

    act(() => result.current.startVirtualConversation());
    expect(result.current.phase).toBe('ready');
    expect(result.current.selection.virtualConversationId).toBe('virtual:newer');
    expect(location.pathname + location.search).toBe('/contexts/context-a/routes/route-a');

    releaseCheckpoint();
    await act(async () => { await olderNavigation; });
    expect(result.current.phase).toBe('ready');
    expect(result.current.selection.virtualConversationId).toBe('virtual:newer');
    expect(result.current.selection.checkpointId).toBe('checkpoint-head');
    expect(location.pathname + location.search).toBe('/contexts/context-a/routes/route-a');
  });

  it('isolates staged attachment IDs by owner and only clears the successful owner', async () => {
    installApi(populatedModel());
    const ids = ['virtual:new:a'];
    const { result, rerender } = renderHook(
      ({ userId }) => useWorkflowWorkspace({
        productId: 'demo',
        userId,
        createVirtualConversationId: () => ids.shift()!,
      }),
      { initialProps: { userId: 'user-a' } },
    );
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    act(() => result.current.setAttachmentIds(['persisted-a']));
    act(() => result.current.startVirtualConversation());
    expect(result.current.attachmentIds).toEqual([]);
    expect(location.pathname + location.search).toBe('/contexts/context-a/routes/route-a');
    act(() => result.current.setAttachmentIds(['virtual-a']));
    await act(async () => {
      await result.current.settleCommand({ outcome: 'failed', code: 'WORKFLOW_FAILED' });
    });
    expect(result.current.attachmentIds).toEqual(['virtual-a']);

    rerender({ userId: 'user-b' });
    await waitFor(() => expect(result.current.selection.conversationId).toBe('conversation-primary'));
    expect(result.current.attachmentIds).toEqual([]);
    act(() => result.current.selectVirtualConversation('virtual:new:a'));
    expect(result.current.attachmentIds).toEqual([]);
    act(() => result.current.setAttachmentIds(['user-b']));

    rerender({ userId: 'user-a' });
    await waitFor(() => expect(result.current.selection.conversationId).toBe('conversation-primary'));
    expect(result.current.attachmentIds).toEqual(['persisted-a']);
    act(() => result.current.selectVirtualConversation('virtual:new:a'));
    expect(result.current.attachmentIds).toEqual(['virtual-a']);

    await act(async () => {
      await result.current.settleCommand({ outcome: 'succeeded' });
    });
    expect(result.current.attachmentIds).toEqual(['persisted-a']);
    act(() => result.current.selectVirtualConversation('virtual:new:a'));
    expect(result.current.attachmentIds).toEqual([]);
    rerender({ userId: 'user-b' });
    await waitFor(() => expect(result.current.selection.conversationId).toBe('conversation-primary'));
    act(() => result.current.selectVirtualConversation('virtual:new:a'));
    expect(result.current.attachmentIds).toEqual(['user-b']);
  });

  it('masks the previous identity while the next identity is loading', async () => {
    const modelA = populatedModel();
    const contextB = context('context-b', '2026-07-19T00:00:00.000Z');
    const routeB = route('route-b', contextB.id, '2026-07-19T00:00:00.000Z');
    const headB = {
      ...checkpoint('checkpoint-b', routeB.id, 0),
      contextId: contextB.id,
    };
    const conversationB = {
      ...conversation('conversation-b', routeB.id, { primary: true }),
      contextId: contextB.id,
    };
    const contextWorkspaceB: ContextWorkspace = { context: contextB, routes: [routeB] };
    const routeWorkspaceB: RouteWorkspace = {
      context: contextB,
      route: routeB,
      checkpoints: [headB],
      conversations: [conversationB],
      selectedCheckpoint: headB,
      headCheckpoint: headB,
      isHistorical: false,
      artifacts: [],
    };
    let loadB = false;
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    const fetchMock = installApi(modelA, {
      '/api/contexts': async () => {
        if (!loadB) return Response.json({ contexts: modelA.contexts });
        await gateB;
        return Response.json({ contexts: [contextB] });
      },
      '/api/contexts/context-b/workspace': async () => Response.json(contextWorkspaceB),
      '/api/routes/route-b/workspace': async () => Response.json(routeWorkspaceB),
    });
    const { result, rerender } = renderHook(
      ({ userId }) => useWorkflowWorkspace({ productId: 'demo', userId }),
      { initialProps: { userId: 'user-a' } },
    );
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    act(() => {
      result.current.setDraft('private A');
      result.current.setAttachmentIds(['attachment-a']);
    });
    const staleActions = {
      setDraft: result.current.setDraft,
      setAttachmentIds: result.current.setAttachmentIds,
      selectVirtualConversation: result.current.selectVirtualConversation,
      selectCheckpoint: result.current.selectCheckpoint,
      settleCommand: result.current.settleCommand,
    };

    loadB = true;
    rerender({ userId: 'user-b' });

    expect(result.current.phase).toBe('loading');
    expect(result.current.selection).toEqual({});
    expect(result.current.workspace).toBeUndefined();
    expect(result.current.draft).toBe('');
    expect(result.current.attachmentIds).toEqual([]);
    await waitFor(() => expect(
      fetchMock.mock.calls.filter(([url]) => url === '/api/contexts'),
    ).toHaveLength(2));
    const loadingRequestCount = fetchMock.mock.calls.length;
    let staleCheckpointWhileLoading!: Promise<void>;
    let staleTerminalWhileLoading!: Promise<void>;
    act(() => {
      staleActions.setDraft('stale A loading');
      staleActions.setAttachmentIds(['stale-attachment-a']);
      staleActions.selectVirtualConversation('virtual:stale-a');
      staleCheckpointWhileLoading = staleActions.selectCheckpoint('checkpoint-old');
      staleTerminalWhileLoading = staleActions.settleCommand({
        outcome: 'succeeded',
        contextId: 'context-a',
        routeId: 'route-a',
        conversationId: 'conversation-primary',
        checkpointId: 'checkpoint-head',
      });
    });
    expect(result.current.selection).toEqual({});
    expect(result.current.phase).toBe('loading');
    expect(location.pathname + location.search).toBe(
      '/contexts/context-a/routes/route-a/conversations/conversation-primary',
    );
    expect(fetchMock.mock.calls).toHaveLength(loadingRequestCount);

    releaseB();
    await act(async () => {
      await Promise.all([staleCheckpointWhileLoading, staleTerminalWhileLoading]);
    });
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.selection).toEqual({
      contextId: 'context-b',
      routeId: 'route-b',
      conversationId: 'conversation-b',
      checkpointId: 'checkpoint-b',
    });
    expect(result.current.workspace?.context.id).toBe('context-b');
    expect(result.current.draft).toBe('');
    expect(result.current.attachmentIds).toEqual([]);
    expect(location.pathname + location.search).toBe(
      '/contexts/context-b/routes/route-b/conversations/conversation-b',
    );

    const readyRequestCount = fetchMock.mock.calls.length;
    let staleCheckpointAfterReady!: Promise<void>;
    let staleTerminalAfterReady!: Promise<void>;
    act(() => {
      staleActions.setDraft('stale A ready');
      staleActions.setAttachmentIds(['stale-ready-attachment-a']);
      staleActions.selectVirtualConversation('virtual:stale-ready-a');
      staleCheckpointAfterReady = staleActions.selectCheckpoint('checkpoint-old');
      staleTerminalAfterReady = staleActions.settleCommand({
        outcome: 'succeeded',
        contextId: 'context-a',
        routeId: 'route-a',
        conversationId: 'conversation-primary',
        checkpointId: 'checkpoint-head',
      });
    });
    await act(async () => {
      await Promise.all([staleCheckpointAfterReady, staleTerminalAfterReady]);
    });
    expect(fetchMock.mock.calls).toHaveLength(readyRequestCount);
    expect(result.current.phase).toBe('ready');
    expect(result.current.selection.contextId).toBe('context-b');
    expect(result.current.selection.conversationId).toBe('conversation-b');
    expect(result.current.draft).toBe('');
    expect(result.current.attachmentIds).toEqual([]);
    expect(location.pathname + location.search).toBe(
      '/contexts/context-b/routes/route-b/conversations/conversation-b',
    );
  });

  it('selects immutable history and reconciles canonical IDs after a successful Command', async () => {
    const model = populatedModel();
    installApi(model);
    const { result } = renderHook(() => useWorkflowWorkspace({ productId: 'demo', userId: 'user-a' }));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    await act(async () => result.current.selectCheckpoint('checkpoint-old'));
    await waitFor(() => expect(result.current.workspace?.isHistorical).toBe(true));
    expect(location.search).toBe('?checkpoint=checkpoint-old');

    act(() => {
      result.current.setDraft('sent');
      result.current.setAttachmentIds(['attachment-a']);
    });
    await act(async () => {
      await result.current.settleCommand({
        outcome: 'succeeded',
        contextId: 'context-a',
        routeId: 'route-a',
        conversationId: 'conversation-primary',
        checkpointId: 'checkpoint-head',
      });
    });

    await waitFor(() => expect(result.current.selection.checkpointId).toBe('checkpoint-head'));
    expect(result.current.draft).toBe('');
    expect(result.current.attachmentIds).toEqual([]);
    expect(location.pathname + location.search).toBe('/contexts/context-a/routes/route-a/conversations/conversation-primary');
  });
});
