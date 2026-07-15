import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { RouteWorkspace, WorkflowCheckpoint, WorkflowContext, WorkflowRoute, WorkflowThread } from './domain/api';

const manifest = {
  contract_version: '1.0' as const,
  product: { id: 'demo', name: 'Workflow Workspace', context_label: '项目', route_label: '路线' },
  workflow: { id: 'demo' },
  stages: [
    { key: 'discover', label: '发现', component_key: 'generic_chat' as const, internal_states: ['start'], actions: [] },
    { key: 'decide', label: '决策', component_key: 'document_workspace' as const, internal_states: ['waiting'], actions: [] },
  ],
};
const user = { id: 'user-1', email: 'reader@example.test', username: 'reader' };
const context: WorkflowContext = {
  id: '20000000-0000-4000-8000-000000000001', title: 'Project Alpha', status: 'active',
  createdAt: '2026-07-15T16:00:00.000Z', updatedAt: '2026-07-15T16:00:00.000Z',
};
const checkpoint: WorkflowCheckpoint = {
  id: '40000000-0000-4000-8000-000000000001', contextId: context.id,
  routeId: '30000000-0000-4000-8000-000000000001', parentCheckpointId: null,
  version: 0, stageKey: 'discover', reason: 'bootstrap',
  snapshot: { stages: [
    { stage_key: 'discover', status: 'active', internal_state: 'start' },
    { stage_key: 'decide', status: 'not_started', internal_state: 'waiting' },
  ] },
  createdAt: '2026-07-15T16:00:00.000Z',
};
const route: WorkflowRoute = {
  id: checkpoint.routeId, contextId: context.id, name: '主线', originCheckpointId: null,
  headCheckpointId: checkpoint.id, createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
};

function routeWorkspace(
  selectedStageKey = 'discover',
  selectedRoute = route,
  selectedCheckpoint = checkpoint,
  threads: WorkflowThread[] = [],
): RouteWorkspace {
  return {
    context,
    route: selectedRoute,
    stages: [
      { stageKey: 'discover', position: 0, status: 'active', internalState: 'start', label: '发现', componentKey: 'generic_chat' },
      { stageKey: 'decide', position: 1, status: 'not_started', internalState: 'waiting', label: '决策', componentKey: 'document_workspace' },
    ],
    checkpoints: [selectedCheckpoint],
    threads,
    selectedStageKey,
    selectedCheckpoint,
    isHistorical: selectedCheckpoint.id !== selectedRoute.headCheckpointId,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  history.replaceState({}, '', '/');
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('persisted workflow workspace', () => {
  it('mounts the persisted conversation workspace for a selected thread URL', async () => {
    const thread: WorkflowThread = {
      id: '50000000-0000-4000-8000-000000000009', contextId: context.id, routeId: route.id,
      stageKey: 'discover', title: 'Selected discussion', status: 'active',
      createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
    };
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/stages/discover?thread=${thread.id}`);
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) return jsonResponse(routeWorkspace('discover', route, checkpoint, [thread]));
      if (url === `/api/threads/${thread.id}/messages`) return jsonResponse({
        messages: [{ id: 'm1', commandId: 'c1', role: 'assistant', content: 'Persisted answer', sequence: 1, createdAt: checkpoint.createdAt }],
        pendingInterrupt: null,
      });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    expect(await screen.findByRole('heading', { name: 'Selected discussion' })).toBeInTheDocument();
    expect(await screen.findByText('Persisted answer')).toBeInTheDocument();
    expect(screen.getByLabelText('消息内容')).toBeInTheDocument();
  });

  it('creates the first context and opens its persisted main route', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/contexts' && !init?.method) return jsonResponse({ contexts: [] });
      if (url === '/api/contexts' && init.method === 'POST') {
        return jsonResponse({ context, route, checkpoint }, 201);
      }
      if (url.startsWith(`/api/routes/${route.id}/workspace?stage=discover`)) {
        return jsonResponse(routeWorkspace());
      }
      throw new Error(`unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    expect(await screen.findByRole('heading', { name: '创建第一个项目' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('项目名称'), 'Project Alpha');
    await userEvent.click(screen.getByRole('button', { name: '创建项目' }));

    expect(await screen.findByRole('heading', { name: '发现' })).toBeInTheDocument();
    expect(screen.getByTestId('navigator-slot')).toBeInTheDocument();
    expect(screen.getByTestId('thread-slot')).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/contexts/${context.id}/routes/${route.id}/stages/discover`);
  });

  it('navigates freely across manifest stages without a mutation request', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/stages/discover`);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.includes('stage=discover')) return jsonResponse(routeWorkspace('discover'));
      if (url.includes('stage=decide')) return jsonResponse(routeWorkspace('decide'));
      throw new Error(`unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });
    await userEvent.click(screen.getByRole('button', { name: '决策' }));
    expect(await screen.findByRole('heading', { name: '决策' })).toBeInTheDocument();
    expect(screen.getByText('document_workspace')).toBeInTheDocument();
    expect(window.location.pathname.endsWith('/stages/decide')).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toEqual([]);
  });

  it('keeps the latest stage navigation when an older request resolves last', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/stages/discover`);
    const slowDecision = deferred<Response>();
    let discoverRequests = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.includes('stage=discover')) {
        discoverRequests += 1;
        return jsonResponse(routeWorkspace('discover'));
      }
      if (url.includes('stage=decide')) return slowDecision.promise;
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });
    await userEvent.click(screen.getByRole('button', { name: '决策' }));
    await userEvent.click(screen.getByRole('button', { name: '发现' }));
    await waitFor(() => expect(discoverRequests).toBe(2));
    await act(async () => {
      slowDecision.resolve(new Response(JSON.stringify(routeWorkspace('decide')), {
        headers: { 'content-type': 'application/json' },
      }));
      await slowDecision.promise;
    });

    expect(screen.getByRole('heading', { name: '发现' })).toBeInTheDocument();
    expect(screen.getByText('generic_chat')).toBeInTheDocument();
    expect(window.location.pathname).toMatch(/\/stages\/discover$/);
  });

  it('treats thread selection as newer navigation than an in-flight stage request', async () => {
    const thread: WorkflowThread = {
      id: '50000000-0000-4000-8000-000000000001', contextId: context.id, routeId: route.id,
      stageKey: 'discover', title: '保留当前讨论', status: 'active', createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
    };
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/stages/discover`);
    const slowDecision = deferred<Response>();
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.includes('stage=discover')) return jsonResponse(routeWorkspace('discover', route, checkpoint, [thread]));
      if (url.includes('stage=decide')) return slowDecision.promise;
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });
    await userEvent.click(screen.getByRole('button', { name: '决策' }));
    await userEvent.click(screen.getByRole('button', { name: thread.title }));
    await act(async () => {
      slowDecision.resolve(new Response(JSON.stringify(routeWorkspace('decide')), {
        headers: { 'content-type': 'application/json' },
      }));
      await slowDecision.promise;
    });

    expect(screen.getByRole('heading', { name: '发现' })).toBeInTheDocument();
    expect(window.location.search).toBe(`?thread=${thread.id}`);
    expect(screen.getByTestId('workspace-slot')).toHaveAttribute('aria-busy', 'false');
  });

  it('loads the draft for the complete URL as soon as navigation changes location', async () => {
    const basePath = `/contexts/${context.id}/routes/${route.id}/stages`;
    localStorage.setItem(`polar-native:demo:draft:${basePath}/discover`, '发现草稿');
    localStorage.setItem(`polar-native:demo:draft:${basePath}/decide`, '决策草稿');
    history.replaceState({}, '', `${basePath}/discover`);
    const slowDecision = deferred<Response>();
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.includes('stage=discover')) return jsonResponse(routeWorkspace('discover'));
      if (url.includes('stage=decide')) return slowDecision.promise;
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await waitFor(() => expect(screen.getByLabelText('阶段草稿')).toHaveValue('发现草稿'));
    await userEvent.click(screen.getByRole('button', { name: '决策' }));

    expect(window.location.pathname).toBe(`${basePath}/decide`);
    await waitFor(() => expect(screen.getByLabelText('阶段草稿')).toHaveValue('决策草稿'));
  });

  it('creates additional contexts and switches back to an existing one', async () => {
    const betaContext: WorkflowContext = { ...context, id: '20000000-0000-4000-8000-000000000002', title: 'Project Beta' };
    const betaCheckpoint: WorkflowCheckpoint = {
      ...checkpoint,
      id: '40000000-0000-4000-8000-000000000002',
      contextId: betaContext.id,
      routeId: '30000000-0000-4000-8000-000000000002',
    };
    const betaRoute: WorkflowRoute = {
      ...route,
      id: betaCheckpoint.routeId,
      contextId: betaContext.id,
      headCheckpointId: betaCheckpoint.id,
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/contexts' && !init?.method) return jsonResponse({ contexts: [context] });
      if (url === '/api/contexts' && init?.method === 'POST') {
        return jsonResponse({ context: betaContext, route: betaRoute, checkpoint: betaCheckpoint }, 201);
      }
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) return jsonResponse(routeWorkspace());
      if (url.startsWith(`/api/routes/${betaRoute.id}/workspace`)) {
        return jsonResponse({ ...routeWorkspace('discover', betaRoute, betaCheckpoint), context: betaContext });
      }
      throw new Error(`unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });
    await userEvent.click(screen.getByRole('button', { name: '新建项目' }));
    await userEvent.type(screen.getByLabelText('项目名称'), 'Project Beta');
    await userEvent.click(screen.getByRole('button', { name: '创建项目' }));
    expect(await screen.findByRole('button', { name: /Project Beta 当前问题空间/ })).toBeInTheDocument();
    expect(window.location.pathname).toContain(betaContext.id);

    await userEvent.click(screen.getByRole('button', { name: /Project Alpha 切换进入/ }));
    await waitFor(() => expect(window.location.pathname).toContain(context.id));
  });

  it('keeps the latest context navigation when an older context request resolves last', async () => {
    const betaContext: WorkflowContext = { ...context, id: '20000000-0000-4000-8000-000000000002', title: 'Project Beta' };
    const betaCheckpoint: WorkflowCheckpoint = {
      ...checkpoint,
      id: '40000000-0000-4000-8000-000000000002',
      contextId: betaContext.id,
      routeId: '30000000-0000-4000-8000-000000000002',
    };
    const betaRoute: WorkflowRoute = {
      ...route,
      id: betaCheckpoint.routeId,
      contextId: betaContext.id,
      headCheckpointId: betaCheckpoint.id,
    };
    const slowBetaContext = deferred<Response>();
    let alphaContextRequests = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context, betaContext] });
      if (url === `/api/contexts/${context.id}/workspace`) {
        alphaContextRequests += 1;
        return jsonResponse({ context, routes: [route] });
      }
      if (url === `/api/contexts/${betaContext.id}/workspace`) return slowBetaContext.promise;
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) return jsonResponse(routeWorkspace());
      if (url.startsWith(`/api/routes/${betaRoute.id}/workspace`)) {
        return jsonResponse({ ...routeWorkspace('discover', betaRoute, betaCheckpoint), context: betaContext });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });
    await userEvent.click(screen.getByRole('button', { name: /Project Beta 切换进入/ }));
    await userEvent.click(screen.getByRole('button', { name: /Project Alpha 当前问题空间/ }));
    await waitFor(() => expect(alphaContextRequests).toBe(2));
    await act(async () => {
      slowBetaContext.resolve(new Response(JSON.stringify({ context: betaContext, routes: [betaRoute] }), {
        headers: { 'content-type': 'application/json' },
      }));
      await slowBetaContext.promise;
    });

    expect(screen.getByRole('button', { name: /Project Alpha 当前问题空间/ })).toBeInTheDocument();
    expect(window.location.pathname).toContain(context.id);
  });

  it('replaces an invalid context deep link with the first accessible workspace', async () => {
    const invalidContextId = '20000000-0000-4000-8000-000000000099';
    history.replaceState({}, '', `/contexts/${invalidContextId}/routes/missing/stages/missing`);
    const replaceSpy = vi.spyOn(history, 'replaceState');
    const pushSpy = vi.spyOn(history, 'pushState');
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) return jsonResponse(routeWorkspace());
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });

    expect(window.location.pathname).toBe(`/contexts/${context.id}/routes/${route.id}/stages/discover`);
    expect(replaceSpy).toHaveBeenCalledWith({}, '', `/contexts/${context.id}/routes/${route.id}/stages/discover`);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('replaces invalid route and stage segments without preserving the broken history entry', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/missing/stages/missing`);
    const replaceSpy = vi.spyOn(history, 'replaceState');
    const pushSpy = vi.spyOn(history, 'pushState');
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) return jsonResponse(routeWorkspace());
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });

    expect(replaceSpy).toHaveBeenCalledWith({}, '', `/contexts/${context.id}/routes/${route.id}/stages/discover`);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('isolates drafts by selected thread and restores them when switching threads', async () => {
    const threadA: WorkflowThread = {
      id: '50000000-0000-4000-8000-000000000001', contextId: context.id, routeId: route.id,
      stageKey: 'discover', title: '讨论 A', status: 'active', createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
    };
    const threadB: WorkflowThread = { ...threadA, id: '50000000-0000-4000-8000-000000000002', title: '讨论 B' };
    const basePath = `/contexts/${context.id}/routes/${route.id}/stages/discover`;
    localStorage.setItem(`polar-native:demo:draft:${basePath}?thread=${threadA.id}`, 'A 的草稿');
    localStorage.setItem(`polar-native:demo:draft:${basePath}?thread=${threadB.id}`, 'B 的草稿');
    history.replaceState({}, '', `${basePath}?thread=${threadA.id}`);
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) return jsonResponse(routeWorkspace('discover', route, checkpoint, [threadA, threadB]));
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByLabelText('阶段草稿');
    await waitFor(() => expect(screen.getByLabelText('阶段草稿')).toHaveValue('A 的草稿'));
    await userEvent.click(screen.getByRole('button', { name: '讨论 B' }));
    expect(screen.getByLabelText('阶段草稿')).toHaveValue('B 的草稿');
    await userEvent.click(screen.getByRole('button', { name: '讨论 A' }));
    expect(screen.getByLabelText('阶段草稿')).toHaveValue('A 的草稿');
  });

  it('isolates drafts by checkpoint and restores the selected checkpoint draft', async () => {
    const historicalCheckpoint: WorkflowCheckpoint = {
      ...checkpoint,
      id: '40000000-0000-4000-8000-000000000009',
      version: 9,
      reason: 'workflow_action',
    };
    const basePath = `/contexts/${context.id}/routes/${route.id}/stages/discover`;
    localStorage.setItem(`polar-native:demo:draft:${basePath}`, '当前草稿');
    localStorage.setItem(`polar-native:demo:draft:${basePath}?checkpoint=${historicalCheckpoint.id}`, '历史草稿');
    history.replaceState({}, '', basePath);
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url.includes(`checkpoint=${historicalCheckpoint.id}`)) {
        return jsonResponse({
          ...routeWorkspace('discover', route, historicalCheckpoint),
          checkpoints: [checkpoint, historicalCheckpoint],
        });
      }
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) {
        return jsonResponse({ ...routeWorkspace(), checkpoints: [checkpoint, historicalCheckpoint] });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByLabelText('阶段草稿');
    await waitFor(() => expect(screen.getByLabelText('阶段草稿')).toHaveValue('当前草稿'));
    await userEvent.click(screen.getByRole('button', { name: /^检查点 09/ }));
    await waitFor(() => expect(screen.getByLabelText('阶段草稿')).toHaveValue('历史草稿'));
    await userEvent.click(screen.getByRole('button', { name: /^检查点 00/ }));
    await waitFor(() => expect(screen.getByLabelText('阶段草稿')).toHaveValue('当前草稿'));
  });

  it('prevents duplicate thread creation while the first submission is pending', async () => {
    const pendingCreate = deferred<Response>();
    let postCount = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url === `/api/routes/${route.id}/threads` && init?.method === 'POST') {
        postCount += 1;
        return pendingCreate.promise;
      }
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) return jsonResponse(routeWorkspace());
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });
    await userEvent.click(screen.getByRole('button', { name: '新建线程' }));
    await userEvent.type(screen.getByLabelText('线程标题'), '唯一线程');
    const submit = screen.getByRole('button', { name: '创建线程' });
    await userEvent.click(submit);
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    expect(postCount).toBe(1);
  });

  it('keeps a successfully created thread instead of reporting that creation failed', async () => {
    const createdThread: WorkflowThread = {
      id: '50000000-0000-4000-8000-000000000001', contextId: context.id, routeId: route.id,
      stageKey: 'discover', title: '已创建线程', status: 'active', createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
    };
    let workspaceRequests = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url === `/api/routes/${route.id}/threads` && init?.method === 'POST') return jsonResponse(createdThread, 201);
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) {
        workspaceRequests += 1;
        return workspaceRequests === 1
          ? jsonResponse(routeWorkspace())
          : jsonResponse({ error: { code: 'SYNC_FAILED' } }, 503);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });
    await userEvent.click(screen.getByRole('button', { name: '新建线程' }));
    await userEvent.type(screen.getByLabelText('线程标题'), createdThread.title);
    await userEvent.click(screen.getByRole('button', { name: '创建线程' }));

    expect(await screen.findByRole('button', { name: createdThread.title })).toBeInTheDocument();
    expect(screen.queryByText('线程没有创建，请检查标题后重试。')).not.toBeInTheDocument();
    expect(workspaceRequests).toBe(1);
  });

  it('does not let thread reconciliation overwrite newer stage navigation', async () => {
    const thread: WorkflowThread = {
      id: '50000000-0000-4000-8000-000000000001', contextId: context.id, routeId: route.id,
      stageKey: 'discover', title: '待改名线程', status: 'active', createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
    };
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/stages/discover?thread=${thread.id}`);
    const slowReconciliation = deferred<Response>();
    let discoverRequests = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url === `/api/threads/${thread.id}` && init?.method === 'PATCH') return jsonResponse({ ...thread, title: '已改名线程' });
      if (url.includes('stage=discover')) {
        discoverRequests += 1;
        return discoverRequests === 1
          ? jsonResponse(routeWorkspace('discover', route, checkpoint, [thread]))
          : slowReconciliation.promise;
      }
      if (url.includes('stage=decide')) return jsonResponse(routeWorkspace('decide'));
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });
    await userEvent.clear(screen.getByLabelText('线程名称'));
    await userEvent.type(screen.getByLabelText('线程名称'), '已改名线程');
    await userEvent.click(screen.getByRole('button', { name: '保存名称' }));
    await waitFor(() => expect(discoverRequests).toBe(2));
    await userEvent.click(screen.getByRole('button', { name: '决策' }));
    await screen.findByRole('heading', { name: '决策' });
    await act(async () => {
      slowReconciliation.resolve(new Response(JSON.stringify(routeWorkspace('discover', route, checkpoint, [thread])), {
        headers: { 'content-type': 'application/json' },
      }));
      await slowReconciliation.promise;
    });

    expect(screen.getByRole('heading', { name: '决策' })).toBeInTheDocument();
  });

  it('reports branch synchronization failure truthfully and prevents duplicate branches', async () => {
    const branchCheckpoint: WorkflowCheckpoint = {
      ...checkpoint,
      id: '40000000-0000-4000-8000-000000000002',
      routeId: '30000000-0000-4000-8000-000000000002',
      parentCheckpointId: checkpoint.id,
      reason: 'branch',
    };
    const branch: WorkflowRoute = {
      ...route,
      id: branchCheckpoint.routeId,
      name: '方案 B',
      originCheckpointId: checkpoint.id,
      headCheckpointId: branchCheckpoint.id,
    };
    const pendingBranch = deferred<Response>();
    let postCount = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route] });
      if (url === `/api/contexts/${context.id}/routes` && init?.method === 'POST') {
        postCount += 1;
        return pendingBranch.promise;
      }
      if (url.startsWith(`/api/routes/${branch.id}/workspace`)) return jsonResponse({ error: { code: 'SYNC_FAILED' } }, 503);
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) return jsonResponse(routeWorkspace());
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '发现' });
    await userEvent.click(screen.getByRole('button', { name: '从此检查点创建新路线' }));
    await userEvent.clear(screen.getByLabelText('新路线名称'));
    await userEvent.type(screen.getByLabelText('新路线名称'), branch.name);
    const submit = screen.getByRole('button', { name: '创建路线' });
    await userEvent.click(submit);
    expect(submit).toBeDisabled();
    await userEvent.click(submit);
    expect(postCount).toBe(1);

    await act(async () => {
      pendingBranch.resolve(new Response(JSON.stringify({ route: branch, checkpoint: branchCheckpoint }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }));
      await pendingBranch.promise;
    });
    expect(await screen.findByRole('button', { name: branch.name })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('新路线已创建，但工作区同步失败');
    expect(screen.queryByText('新路线没有创建，请稍后重试。')).not.toBeInTheDocument();
  });

  it('creates parallel stage threads and derives a new route from a checkpoint', async () => {
    history.replaceState({}, '', `/contexts/${context.id}/routes/${route.id}/stages/decide`);
    const threads: WorkflowThread[] = [];
    const branchCheckpoint: WorkflowCheckpoint = {
      ...checkpoint,
      id: '40000000-0000-4000-8000-000000000002',
      routeId: '30000000-0000-4000-8000-000000000002',
      parentCheckpointId: checkpoint.id,
      reason: 'branch',
    };
    const branch: WorkflowRoute = {
      ...route,
      id: branchCheckpoint.routeId,
      name: '方案 B',
      originCheckpointId: checkpoint.id,
      headCheckpointId: branchCheckpoint.id,
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/contexts') return jsonResponse({ contexts: [context] });
      if (url === `/api/contexts/${context.id}/workspace`) return jsonResponse({ context, routes: [route, branch] });
      if (url === `/api/routes/${route.id}/threads` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const item: WorkflowThread = {
          id: `50000000-0000-4000-8000-00000000000${threads.length + 1}`,
          contextId: context.id, routeId: route.id, stageKey: body.stageKey, title: body.title,
          status: 'active', createdAt: checkpoint.createdAt, updatedAt: checkpoint.createdAt,
        };
        threads.unshift(item);
        return jsonResponse(item, 201);
      }
      if (url === `/api/contexts/${context.id}/routes` && init?.method === 'POST') {
        return jsonResponse({ route: branch, checkpoint: branchCheckpoint }, 201);
      }
      if (url.startsWith(`/api/routes/${branch.id}/workspace`)) {
        return jsonResponse(routeWorkspace('decide', branch, branchCheckpoint));
      }
      if (url.startsWith(`/api/routes/${route.id}/workspace`)) {
        return jsonResponse(routeWorkspace('decide', route, checkpoint, [...threads]));
      }
      throw new Error(`unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App manifest={manifest} user={user} />);
    await screen.findByRole('heading', { name: '决策' });
    for (const title of ['方案怎么做', '模版怎么改']) {
      await userEvent.click(screen.getByRole('button', { name: '新建线程' }));
      await userEvent.clear(screen.getByLabelText('线程标题'));
      await userEvent.type(screen.getByLabelText('线程标题'), title);
      await userEvent.click(screen.getByRole('button', { name: '创建线程' }));
      expect(await screen.findByRole('button', { name: title })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('button', { name: /方案怎么做|模版怎么改/ })).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: /^检查点 00/ }));
    await userEvent.click(screen.getByRole('button', { name: '从此检查点创建新路线' }));
    await userEvent.clear(screen.getByLabelText('新路线名称'));
    await userEvent.type(screen.getByLabelText('新路线名称'), '方案 B');
    await userEvent.click(screen.getByRole('button', { name: '创建路线' }));

    await waitFor(() => expect(window.location.pathname).toContain(`/routes/${branch.id}/`));
    expect(await screen.findByText('方案 B')).toBeInTheDocument();
    expect(screen.getByText('源自检查点 00')).toBeInTheDocument();
  });
});
