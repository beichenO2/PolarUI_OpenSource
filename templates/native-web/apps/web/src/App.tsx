import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import type { SessionUser } from './auth/api';
import { StageWorkspace } from './stages/StageWorkspace';
import { ArchivePanel } from './archive/ArchivePanel';
import { VersionArchive } from './workspace/VersionArchive';
import { ThreadDrawer } from './workspace/ThreadDrawer';
import {
  createRouteFromVersion,
  createContext,
  createThread,
  getContextWorkspace,
  getRouteWorkspace,
  listContexts,
  updateThread,
  type ContextWorkspace,
  type RouteWorkspace,
  type WorkflowContext,
} from './domain/api';

export type PublicProductManifest = Omit<ProductManifest, 'workflow'> & { workflow: { id: string } };

interface WorkspaceLocation {
  contextId: string;
  routeId: string;
  stageKey: string;
  threadId?: string;
}

const workspaceLabel = '工作空间';

type NavigationResult = 'loaded' | 'failed' | 'stale';

function parseWorkspaceLocation(): WorkspaceLocation | null {
  const match = window.location.pathname.match(
    /^\/contexts\/([^/]+)\/routes\/([^/]+)\/stages\/([^/]+)\/?$/,
  );
  if (!match) return null;
  const query = new URLSearchParams(window.location.search);
  return {
    contextId: decodeURIComponent(match[1]!),
    routeId: decodeURIComponent(match[2]!),
    stageKey: decodeURIComponent(match[3]!),
    threadId: query.get('thread') ?? undefined,
  };
}

function workspacePath(location: WorkspaceLocation): string {
  const path = `/contexts/${encodeURIComponent(location.contextId)}` +
    `/routes/${encodeURIComponent(location.routeId)}` +
    `/stages/${encodeURIComponent(location.stageKey)}`;
  const query = new URLSearchParams();
  if (location.threadId) query.set('thread', location.threadId);
  return query.size ? `${path}?${query}` : path;
}

function ProductBar({ manifest, user, onLogout, onArchive }: {
  manifest: PublicProductManifest;
  user?: SessionUser;
  onLogout?: () => void;
  onArchive?: () => void;
}) {
  return <header className="product-bar" data-testid="product-bar">
    <div className="product-identity">
      <span className="product-mark" aria-hidden="true">P</span>
      <div>
        <strong>{manifest.product.name}</strong>
        <span className="product-subtitle">路线工作空间</span>
      </div>
    </div>
    <div className="workflow-status">
      <span className="status-dot" aria-hidden="true" />
      <span className="status-label">已同步</span>
      {user && <button className="header-logout" type="button" onClick={onArchive}>导入档案</button>}
      {user && <button className="header-logout" type="button" onClick={onLogout}>{user.username} · 退出</button>}
    </div>
  </header>;
}

export function App({ manifest, user, onLogout }: {
  manifest: PublicProductManifest;
  user?: SessionUser;
  onLogout?: () => void;
}) {
  const [contexts, setContexts] = useState<WorkflowContext[] | null>(null);
  const [contextState, setContextState] = useState<ContextWorkspace | null>(null);
  const [workspace, setWorkspace] = useState<RouteWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [contextTitle, setContextTitle] = useState('');
  const [showContextForm, setShowContextForm] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [contextSubmitting, setContextSubmitting] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showVersionArchive, setShowVersionArchive] = useState(false);
  const [threadDrawerOpen, setThreadDrawerOpen] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const navigationGeneration = useRef(0);
  const contextSubmission = useRef(false);
  const threadSubmission = useRef(false);
  const threadDrawerTrigger = useRef<HTMLButtonElement>(null);

  const replaceLocation = useCallback((location: WorkspaceLocation, replace = false) => {
    const next = workspacePath(location);
    history[replace ? 'replaceState' : 'pushState']({}, '', next);
    setSelectedThreadId(location.threadId);
  }, []);

  const selectLocalLocation = useCallback((location: WorkspaceLocation, replace = false) => {
    navigationGeneration.current += 1;
    setLoading(false);
    setError('');
    replaceLocation(location, replace);
  }, [replaceLocation]);

  const openRoute = useCallback(async (
    location: WorkspaceLocation,
    options: { replace?: boolean; generation?: number; failureMessage?: string } = {},
  ): Promise<NavigationResult> => {
    const generation = options.generation ?? ++navigationGeneration.current;
    if (generation !== navigationGeneration.current) return 'stale';
    setLoading(true);
    setError('');
    replaceLocation(location, options.replace);
    try {
      const next = await getRouteWorkspace(location.routeId, location.stageKey);
      if (generation !== navigationGeneration.current) return 'stale';
      setWorkspace(next);
      const canonicalLocation: WorkspaceLocation = {
        contextId: next.context.id,
        routeId: next.route.id,
        stageKey: next.selectedStageKey,
        threadId: location.threadId && next.threads.some((item) => item.id === location.threadId)
          ? location.threadId
          : undefined,
      };
      if (workspacePath(canonicalLocation) !== workspacePath(location)) {
        replaceLocation(canonicalLocation, true);
      }
      return 'loaded';
    } catch {
      if (generation !== navigationGeneration.current) return 'stale';
      setError(options.failureMessage ?? '工作空间暂时无法载入，请刷新后重试。');
      return 'failed';
    } finally {
      if (generation === navigationGeneration.current) setLoading(false);
    }
  }, [replaceLocation]);

  const openContext = useCallback(async (
    contextId: string,
    preferred?: Partial<WorkspaceLocation>,
    replace = false,
  ): Promise<NavigationResult> => {
    const generation = ++navigationGeneration.current;
    setLoading(true);
    setError('');
    try {
      const nextContext = await getContextWorkspace(contextId);
      if (generation !== navigationGeneration.current) return 'stale';
      const preferredRoute = nextContext.routes.find((item) => item.id === preferred?.routeId);
      const route = preferredRoute ?? nextContext.routes[0];
      if (!route) throw new Error('context has no route');
      const preferredStage = manifest.stages.some((item) => item.key === preferred?.stageKey);
      const stageKey = preferredStage ? preferred!.stageKey! : manifest.stages[0]!.key;
      setContextState(nextContext);
      return await openRoute({
        contextId,
        routeId: route.id,
        stageKey,
        threadId: preferred?.threadId,
      }, {
        generation,
        replace: replace || Boolean(preferred?.routeId && !preferredRoute) || Boolean(preferred?.stageKey && !preferredStage),
      });
    } catch {
      if (generation !== navigationGeneration.current) return 'stale';
      setError('工作空间暂时无法载入，请刷新后重试。');
      setLoading(false);
      return 'failed';
    }
  }, [manifest.stages, openRoute]);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      try {
        const result = await listContexts();
        if (!active) return;
        setContexts(result.contexts);
        if (result.contexts.length === 0) {
          setLoading(false);
          return;
        }
        const location = parseWorkspaceLocation();
        const selectedContext = result.contexts.find((item) => item.id === location?.contextId) ?? result.contexts[0]!;
        const validContextLocation = location?.contextId === selectedContext.id ? location : undefined;
        await openContext(selectedContext.id, validContextLocation, !validContextLocation);
      } catch {
        if (active) {
          setError('工作空间列表暂时无法载入，请刷新后重试。');
          setLoading(false);
        }
      }
    };
    void boot();
    const onPopState = () => {
      const location = parseWorkspaceLocation();
      if (location) {
        void openContext(location.contextId, location, true);
      }
    };
    addEventListener('popstate', onPopState);
    return () => {
      active = false;
      navigationGeneration.current += 1;
      removeEventListener('popstate', onPopState);
    };
  }, [openContext]);

  const activeStage = workspace?.stages.find((item) => item.stageKey === workspace.selectedStageKey);
  const activeStageDefinition = manifest.stages.find((item) => item.key === workspace?.selectedStageKey);
  const activeThread = workspace?.threads.find((item) => item.id === selectedThreadId);
  const currentLocation = workspace ? {
    contextId: workspace.context.id,
    routeId: workspace.route.id,
    stageKey: workspace.selectedStageKey,
    threadId: selectedThreadId,
  } : null;
  if (contexts && contexts.length === 0) {
    return <div className="empty-shell">
      <ProductBar manifest={manifest} user={user} onLogout={onLogout} onArchive={() => setShowArchive(true)} />
      {showArchive && <ArchivePanel onClose={() => setShowArchive(false)} />}
      <main className="context-empty">
        <p className="eyebrow">{workspaceLabel} / 01</p>
        <h1>创建第一个{workspaceLabel}</h1>
        <p>为这项工作命名，然后从第一条路线开始。</p>
        <form onSubmit={async (event) => {
          event.preventDefault();
          if (contextSubmission.current) return;
          contextSubmission.current = true;
          setContextSubmitting(true);
          setError('');
          try {
            const created = await createContext(contextTitle);
            setContexts([created.context]);
            setContextState({ context: created.context, routes: [created.route] });
            await openRoute({
              contextId: created.context.id,
              routeId: created.route.id,
              stageKey: manifest.stages[0]!.key,
            }, { failureMessage: `${workspaceLabel}已创建，但同步失败，请刷新后重试。` });
          } catch {
            setError(`没有创建${workspaceLabel}，请检查名称后重试。`);
          } finally {
            contextSubmission.current = false;
            setContextSubmitting(false);
          }
        }}>
          <label>{workspaceLabel}名称
            <input value={contextTitle} onChange={(event) => setContextTitle(event.target.value)} maxLength={120} required />
          </label>
          <button type="submit" disabled={contextSubmitting}>{contextSubmitting ? '正在创建…' : `创建${workspaceLabel}`}</button>
        </form>
        {error && <p className="domain-error" role="alert">{error}</p>}
      </main>
    </div>;
  }

  if (loading && !workspace) {
    return <div className="empty-shell"><ProductBar manifest={manifest} user={user} onLogout={onLogout} onArchive={() => setShowArchive(true)} />
      {showArchive && <ArchivePanel onClose={() => setShowArchive(false)} />}
      <main className="context-empty"><p>正在载入工作空间…</p></main>
    </div>;
  }

  if (!workspace || !activeStage || !currentLocation) {
    return <div className="empty-shell"><ProductBar manifest={manifest} user={user} onLogout={onLogout} onArchive={() => setShowArchive(true)} />
      {showArchive && <ArchivePanel onClose={() => setShowArchive(false)} />}
      <main className="context-empty"><p role="alert">{error || '工作区没有可显示的路线。'}</p></main>
    </div>;
  }

  return <div className="app-shell">
    <ProductBar manifest={manifest} user={user} onLogout={onLogout} onArchive={() => setShowArchive(true)} />
    {showArchive && <ArchivePanel onClose={() => setShowArchive(false)} />}
    {showVersionArchive && <VersionArchive
      checkpoints={workspace.checkpoints}
      routeName={workspace.route.name}
      stageLabels={Object.fromEntries(manifest.stages.map((stage) => [stage.key, stage.label]))}
      onClose={() => setShowVersionArchive(false)}
      onCreateRoute={async (sourceCheckpointId, name) => {
        const source = workspace.checkpoints.find((item) => item.id === sourceCheckpointId);
        if (!source) throw new Error('version not found');
        const result = await createRouteFromVersion(workspace.context.id, { sourceCheckpointId, name });
        setContextState((current) => current && current.context.id === workspace.context.id
          ? { ...current, routes: current.routes.some((item) => item.id === result.route.id)
            ? current.routes
            : [...current.routes, result.route] }
          : current);
        setShowVersionArchive(false);
        const navigation = await openContext(workspace.context.id, {
          routeId: result.route.id,
          stageKey: source.stageKey,
        }, true);
        if (navigation === 'failed') setError('新路线已创建，但工作空间同步失败，请重新打开路线。');
      }}
    />}

    <aside className="navigator" data-testid="navigator-slot">
      <section>
        <div className="section-heading">
          <p className="eyebrow">{workspaceLabel}</p>
          <span>{String(contexts?.length ?? 0).padStart(2, '0')}</span>
        </div>
        <div className="context-list">
          {contexts?.map((item, index) => <button
            className={item.id === workspace.context.id ? 'context-card active-context' : 'context-card'}
            key={item.id}
            type="button"
            onClick={() => void openContext(item.id)}
          >
            <span className="context-index">{String(index + 1).padStart(2, '0')}</span>
            <span><strong>{item.title}</strong><small>{item.id === workspace.context.id ? '当前' : '打开'}</small></span>
          </button>)}
        </div>
        {!showContextForm && <button aria-label={`新建${workspaceLabel}`} className="new-context-button" type="button" onClick={() => setShowContextForm(true)}>
          ＋ 新建{workspaceLabel}
        </button>}
        {showContextForm && <form className="inline-form context-form" onSubmit={async (event) => {
          event.preventDefault();
          if (contextSubmission.current) return;
          contextSubmission.current = true;
          setContextSubmitting(true);
          setError('');
          try {
            const created = await createContext(contextTitle);
            setContexts((current) => [created.context, ...(current ?? [])]);
            setContextState({ context: created.context, routes: [created.route] });
            setContextTitle('');
            setShowContextForm(false);
            await openRoute({
              contextId: created.context.id,
              routeId: created.route.id,
              stageKey: manifest.stages[0]!.key,
            }, { failureMessage: `${workspaceLabel}已创建，但同步失败，请重新打开。` });
          } catch {
            setError(`没有创建${workspaceLabel}，请检查名称后重试。`);
          } finally {
            contextSubmission.current = false;
            setContextSubmitting(false);
          }
        }}>
          <label>{workspaceLabel}名称<input value={contextTitle} onChange={(event) => setContextTitle(event.target.value)} maxLength={120} required autoFocus /></label>
          <div><button type="submit" disabled={contextSubmitting}>{contextSubmitting ? '正在创建…' : `创建${workspaceLabel}`}</button><button type="button" disabled={contextSubmitting} onClick={() => setShowContextForm(false)}>取消</button></div>
        </form>}
      </section>

      <section className="route-section">
        <p className="eyebrow">{manifest.product.route_label}</p>
        <div className="route-list">
          {contextState?.routes.map((item) => <button
            aria-current={item.id === workspace.route.id ? 'page' : undefined}
            className={item.id === workspace.route.id ? 'route-chip active-route' : 'route-chip'}
            key={item.id}
            onClick={() => void openRoute({ ...currentLocation, routeId: item.id, threadId: undefined })}
            type="button"
          >{item.name}</button>)}
        </div>
        {workspace.route.originCheckpointId && <p className="route-origin">
          {workspace.route.origin
            ? `来源：${workspace.route.origin.routeName} / 版本 ${String(workspace.route.origin.version).padStart(2, '0')}`
            : '来源：版本记录'}
        </p>}
      </section>

      <section className="stage-section">
        <div className="section-heading"><p className="eyebrow">阶段</p><span>
          {String(activeStage.position + 1).padStart(2, '0')} / {String(workspace.stages.length).padStart(2, '0')}
        </span></div>
        <nav aria-label="阶段导航" className="stage-nav">
          {workspace.stages.map((item) => <button
            aria-label={item.label}
            aria-current={item.stageKey === activeStage.stageKey ? 'step' : undefined}
            className={item.stageKey === activeStage.stageKey ? 'stage-link active' : 'stage-link'}
            key={item.stageKey}
            onClick={() => void openRoute({ ...currentLocation, stageKey: item.stageKey, threadId: undefined })}
            type="button"
          >
            <span className={`stage-number stage-${item.status}`}>{String(item.position + 1).padStart(2, '0')}</span>
            <span><span className="stage-label">{item.label}</span><small>{item.status === 'active' ? '进行中' : item.status === 'completed' ? '已完成' : '可提前讨论'}</small></span>
          </button>)}
        </nav>
      </section>

    </aside>

    <main className="workspace" data-testid="workspace-slot" aria-busy={loading}>
      <div className="workspace-heading">
        <div><p className="eyebrow">{workspace.context.title} / {workspace.route.name}</p><h1>{activeStage.label}</h1></div>
        <div className="workspace-heading-actions"><button type="button" onClick={() => setShowVersionArchive(true)}>版本</button></div>
      </div>
      {error && <p className="domain-error" role="alert">{error}</p>}

      {activeStageDefinition && <StageWorkspace
        componentKey={activeStageDefinition.component_key}
        routeId={workspace.route.id}
        stageKey={activeStage.stageKey}
        revision={workspaceRevision}
      />}
      <button
        ref={threadDrawerTrigger}
        className="discussion-trigger"
        type="button"
        aria-label={`打开讨论，${workspace.threads.length} 个`}
        onClick={() => {
          if (!activeThread && workspace.threads[0]) {
            selectLocalLocation({ ...currentLocation, threadId: workspace.threads[0].id });
          }
          setThreadDrawerOpen(true);
        }}
      >
        <span>阶段讨论</span><strong>{workspace.threads.length}</strong>
      </button>
    </main>

    {threadDrawerOpen && <ThreadDrawer
      threads={workspace.threads}
      selectedThreadId={activeThread?.id}
      stageLabel={activeStage.label}
      returnFocusRef={threadDrawerTrigger}
      onClose={() => setThreadDrawerOpen(false)}
      onSelectThread={(threadId) => selectLocalLocation({ ...currentLocation, threadId })}
      onCreateThread={async (title) => {
        if (threadSubmission.current) return;
        threadSubmission.current = true;
        try {
          const created = await createThread(workspace.route.id, { stageKey: activeStage.stageKey, title });
          setWorkspace((current) => {
            if (!current || current.route.id !== created.routeId || current.selectedStageKey !== created.stageKey) return current;
            if (current.threads.some((item) => item.id === created.id)) return current;
            return { ...current, threads: [created, ...current.threads] };
          });
          selectLocalLocation({ ...currentLocation, threadId: created.id });
        } finally {
          threadSubmission.current = false;
        }
      }}
      onRenameThread={async (threadId, title) => {
        await updateThread(threadId, { title });
        const navigation = await openRoute(currentLocation, {
          replace: true,
          failureMessage: '讨论名称已保存，但工作空间同步失败，请重新打开。',
        });
        if (navigation === 'failed') throw new Error('discussion reconciliation failed');
      }}
      onArchiveThread={async (threadId) => {
        await updateThread(threadId, { status: 'archived' });
        const navigation = await openRoute({ ...currentLocation, threadId: undefined }, {
          replace: true,
          failureMessage: '讨论已归档，但工作空间同步失败，请重新打开。',
        });
        if (navigation === 'failed') throw new Error('discussion reconciliation failed');
      }}
      revision={workspaceRevision}
      conversation={activeThread && activeStageDefinition ? {
        thread: activeThread,
        stage: activeStage,
        checkpoint: workspace.selectedCheckpoint,
        actions: activeStageDefinition.actions,
        draftScope: {
          productId: manifest.product.id,
          userId: user?.id ?? 'anonymous',
          contextId: workspace.context.id,
          routeId: workspace.route.id,
          stageKey: activeStage.stageKey,
          threadId: activeThread.id,
        },
        onCommandFinished: (result) => {
          if (result.outcome !== 'succeeded') return;
          const nextStageKey = result.stageKey && manifest.stages.some((item) => item.key === result.stageKey)
            ? result.stageKey
            : activeStage.stageKey;
          void (async () => {
            const navigation = result.resultRouteId && result.resultRouteId !== workspace.route.id
              ? await openContext(workspace.context.id, {
                  routeId: result.resultRouteId,
                  stageKey: nextStageKey,
                  threadId: result.resultThreadId,
                }, true)
              : await openRoute({
                  ...currentLocation,
                  stageKey: nextStageKey,
                  threadId: result.resultThreadId ?? activeThread.id,
                }, { replace: true });
            if (navigation === 'loaded') setWorkspaceRevision((current) => current + 1);
          })();
        },
        onConflict: () => void openRoute(currentLocation, { replace: true }),
      } : undefined}
    />}
  </div>;
}
