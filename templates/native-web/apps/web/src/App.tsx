import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import type { SessionUser } from './auth/api';
import { readDraft, writeDraft } from './auth/storage';
import { ThreadConversation } from './commands/ThreadConversation';
import {
  branchRoute,
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
  checkpointId?: string;
  threadId?: string;
}

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
    checkpointId: query.get('checkpoint') ?? undefined,
    threadId: query.get('thread') ?? undefined,
  };
}

function workspacePath(location: WorkspaceLocation): string {
  const path = `/contexts/${encodeURIComponent(location.contextId)}` +
    `/routes/${encodeURIComponent(location.routeId)}` +
    `/stages/${encodeURIComponent(location.stageKey)}`;
  const query = new URLSearchParams();
  if (location.checkpointId) query.set('checkpoint', location.checkpointId);
  if (location.threadId) query.set('thread', location.threadId);
  return query.size ? `${path}?${query}` : path;
}

function ProductBar({ manifest, user, onLogout }: {
  manifest: PublicProductManifest;
  user?: SessionUser;
  onLogout?: () => void;
}) {
  return <header className="product-bar" data-testid="product-bar">
    <div className="product-identity">
      <span className="product-mark" aria-hidden="true">P</span>
      <div>
        <strong>{manifest.product.name}</strong>
        <span className="product-subtitle">Workflow field notes</span>
      </div>
    </div>
    <div className="workflow-status">
      <span className="status-dot" aria-hidden="true" />
      <span>{manifest.workflow.id}</span>
      <span className="status-label">持久化工作区</span>
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
  const [threadTitle, setThreadTitle] = useState('');
  const [showThreadForm, setShowThreadForm] = useState(false);
  const [branchName, setBranchName] = useState('新路线');
  const [showBranchForm, setShowBranchForm] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [threadRename, setThreadRename] = useState('');
  const [draft, setDraft] = useState('');
  const [draftPath, setDraftPath] = useState(() => {
    const location = parseWorkspaceLocation();
    return location ? workspacePath(location) : '';
  });
  const [contextSubmitting, setContextSubmitting] = useState(false);
  const [threadSubmitting, setThreadSubmitting] = useState(false);
  const [branchSubmitting, setBranchSubmitting] = useState(false);
  const navigationGeneration = useRef(0);
  const contextSubmission = useRef(false);
  const threadSubmission = useRef(false);
  const branchSubmission = useRef(false);

  const replaceLocation = useCallback((location: WorkspaceLocation, replace = false) => {
    const next = workspacePath(location);
    history[replace ? 'replaceState' : 'pushState']({}, '', next);
    setSelectedThreadId(location.threadId);
    setDraftPath(next);
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
      const next = await getRouteWorkspace(location.routeId, location.stageKey, location.checkpointId);
      if (generation !== navigationGeneration.current) return 'stale';
      setWorkspace(next);
      const canonicalLocation: WorkspaceLocation = {
        contextId: next.context.id,
        routeId: next.route.id,
        stageKey: next.selectedStageKey,
        checkpointId: next.isHistorical ? next.selectedCheckpoint.id : undefined,
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
      setError(options.failureMessage ?? '工作区暂时无法载入，请刷新后重试。');
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
        checkpointId: preferred?.checkpointId,
        threadId: preferred?.threadId,
      }, {
        generation,
        replace: replace || Boolean(preferred?.routeId && !preferredRoute) || Boolean(preferred?.stageKey && !preferredStage),
      });
    } catch {
      if (generation !== navigationGeneration.current) return 'stale';
      setError('工作区暂时无法载入，请刷新后重试。');
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
          setError('工作区列表暂时无法载入，请刷新后重试。');
          setLoading(false);
        }
      }
    };
    void boot();
    const onPopState = () => {
      const location = parseWorkspaceLocation();
      if (location) {
        setDraftPath(workspacePath(location));
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
    checkpointId: workspace.isHistorical ? workspace.selectedCheckpoint.id : undefined,
    threadId: selectedThreadId,
  } : null;
  const currentDraftPath = draftPath;

  useEffect(() => {
    if (currentDraftPath) setDraft(readDraft(manifest.product.id, currentDraftPath));
  }, [currentDraftPath, manifest.product.id]);
  if (contexts && contexts.length === 0) {
    return <div className="empty-shell">
      <ProductBar manifest={manifest} user={user} onLogout={onLogout} />
      <main className="context-empty">
        <p className="eyebrow">{manifest.product.context_label} / 01</p>
        <h1>创建第一个{manifest.product.context_label}</h1>
        <p>每个{manifest.product.context_label}都是独立的问题空间。创建后会同时生成主线和第一个不可变检查点。</p>
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
            }, { failureMessage: `${manifest.product.context_label}已创建，但工作区同步失败，请刷新后重试。` });
          } catch {
            setError(`没有创建${manifest.product.context_label}，请检查名称后重试。`);
          } finally {
            contextSubmission.current = false;
            setContextSubmitting(false);
          }
        }}>
          <label>{manifest.product.context_label}名称
            <input value={contextTitle} onChange={(event) => setContextTitle(event.target.value)} maxLength={120} required />
          </label>
          <button type="submit" disabled={contextSubmitting}>{contextSubmitting ? '正在创建…' : `创建${manifest.product.context_label}`}</button>
        </form>
        {error && <p className="domain-error" role="alert">{error}</p>}
      </main>
    </div>;
  }

  if (loading && !workspace) {
    return <div className="empty-shell"><ProductBar manifest={manifest} user={user} onLogout={onLogout} />
      <main className="context-empty"><p>正在载入工作区…</p></main>
    </div>;
  }

  if (!workspace || !activeStage || !currentLocation) {
    return <div className="empty-shell"><ProductBar manifest={manifest} user={user} onLogout={onLogout} />
      <main className="context-empty"><p role="alert">{error || '工作区没有可显示的路线。'}</p></main>
    </div>;
  }

  const branchControls = <div className="branch-controls">
    <button className="branch-trigger" type="button" onClick={() => setShowBranchForm(true)}>
      从此检查点创建新路线
    </button>
    {showBranchForm && <form className="inline-form branch-form" onSubmit={async (event) => {
      event.preventDefault();
      if (branchSubmission.current) return;
      branchSubmission.current = true;
      setBranchSubmitting(true);
      setError('');
      try {
        const result = await branchRoute(workspace.context.id, {
          sourceCheckpointId: workspace.selectedCheckpoint.id,
          name: branchName,
        });
        setContextState((current) => {
          if (!current || current.context.id !== workspace.context.id || current.routes.some((item) => item.id === result.route.id)) {
            return current;
          }
          return { ...current, routes: [...current.routes, result.route] };
        });
        setShowBranchForm(false);
        await openRoute({
          contextId: workspace.context.id,
          routeId: result.route.id,
          stageKey: activeStage.stageKey,
        }, {
          failureMessage: '新路线已创建，但工作区同步失败，请重新打开路线。',
        });
      } catch {
        setError('新路线没有创建，请稍后重试。');
      } finally {
        branchSubmission.current = false;
        setBranchSubmitting(false);
      }
    }}>
      <label>新路线名称<input value={branchName} onChange={(event) => setBranchName(event.target.value)} required maxLength={120} /></label>
      <div><button type="submit" disabled={branchSubmitting}>{branchSubmitting ? '正在创建…' : '创建路线'}</button><button type="button" disabled={branchSubmitting} onClick={() => setShowBranchForm(false)}>取消</button></div>
    </form>}
    {error && <p className="domain-error" role="alert">{error}</p>}
  </div>;

  return <div className="app-shell">
    <ProductBar manifest={manifest} user={user} onLogout={onLogout} />

    <aside className="navigator" data-testid="navigator-slot">
      <section>
        <div className="section-heading">
          <p className="eyebrow">{manifest.product.context_label}</p>
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
            <span><strong>{item.title}</strong><small>{item.id === workspace.context.id ? '当前问题空间' : '切换进入'}</small></span>
          </button>)}
        </div>
        {!showContextForm && <button aria-label={`新建${manifest.product.context_label}`} className="new-context-button" type="button" onClick={() => setShowContextForm(true)}>
          ＋ 新建{manifest.product.context_label}
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
            }, { failureMessage: `${manifest.product.context_label}已创建，但工作区同步失败，请重新打开。` });
          } catch {
            setError(`没有创建${manifest.product.context_label}，请检查名称后重试。`);
          } finally {
            contextSubmission.current = false;
            setContextSubmitting(false);
          }
        }}>
          <label>{manifest.product.context_label}名称<input value={contextTitle} onChange={(event) => setContextTitle(event.target.value)} maxLength={120} required autoFocus /></label>
          <div><button type="submit" disabled={contextSubmitting}>{contextSubmitting ? '正在创建…' : `创建${manifest.product.context_label}`}</button><button type="button" disabled={contextSubmitting} onClick={() => setShowContextForm(false)}>取消</button></div>
        </form>}
      </section>

      <section className="route-section">
        <p className="eyebrow">{manifest.product.route_label}</p>
        <div className="route-list">
          {contextState?.routes.map((item) => <button
            aria-current={item.id === workspace.route.id ? 'page' : undefined}
            className={item.id === workspace.route.id ? 'route-chip active-route' : 'route-chip'}
            key={item.id}
            onClick={() => void openRoute({ ...currentLocation, routeId: item.id, checkpointId: undefined, threadId: undefined })}
            type="button"
          >{item.name}</button>)}
        </div>
        {workspace.route.originCheckpointId && <p className="route-origin">
          源自检查点 {String(workspace.selectedCheckpoint.version).padStart(2, '0')}
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
            onClick={() => void openRoute({ ...currentLocation, stageKey: item.stageKey, checkpointId: undefined, threadId: undefined })}
            type="button"
          >
            <span className={`stage-number stage-${item.status}`}>{String(item.position + 1).padStart(2, '0')}</span>
            <span><span className="stage-label">{item.label}</span><small>{item.status === 'active' ? '进行中' : item.status === 'completed' ? '已完成' : '可提前讨论'}</small></span>
          </button>)}
        </nav>
      </section>

      <section className="checkpoint-section">
        <p className="eyebrow">检查点</p>
        <div className="checkpoint-list">
          {workspace.checkpoints.map((item) => <button
            aria-current={item.id === workspace.selectedCheckpoint.id ? 'true' : undefined}
            className={item.id === workspace.selectedCheckpoint.id ? 'checkpoint-button selected-checkpoint' : 'checkpoint-button'}
            key={item.id}
            onClick={() => void openRoute({ ...currentLocation, checkpointId: item.id })}
            type="button"
          >
            <strong>检查点 {String(item.version).padStart(2, '0')}</strong>
            <span>{item.reason === 'bootstrap' ? '路线建立' : item.reason === 'branch' ? '路线派生' : '受控动作'}</span>
          </button>)}
        </div>
      </section>
      <p className="navigator-note">浏览不会推进状态。任何共享状态变化都必须生成新的检查点。</p>
    </aside>

    <main className="workspace" data-testid="workspace-slot" aria-busy={loading}>
      <div className="workspace-heading">
        <div><p className="eyebrow">{workspace.context.title} / {workspace.route.name}</p><h1>{activeStage.label}</h1></div>
        <span className="component-key">{activeStage.componentKey}</span>
      </div>

      {workspace.isHistorical && <div className="history-banner" role="status">
        正在浏览历史检查点 {String(workspace.selectedCheckpoint.version).padStart(2, '0')}。原路线仍停留在最新头部。
      </div>}

      {activeThread && activeStageDefinition ? <>
        <ThreadConversation
          thread={activeThread}
          stage={activeStage}
          checkpoint={workspace.selectedCheckpoint}
          actions={activeStageDefinition.actions}
          onCommandFinished={(result) => {
            if (result.outcome !== 'succeeded') return;
            const nextStageKey = result.stageKey && manifest.stages.some((item) => item.key === result.stageKey)
              ? result.stageKey
              : activeStage.stageKey;
            if (result.resultRouteId && result.resultRouteId !== workspace.route.id) {
              void openContext(workspace.context.id, {
                routeId: result.resultRouteId,
                stageKey: nextStageKey,
                threadId: result.resultThreadId,
              }, true);
            } else {
              void openRoute({
                ...currentLocation,
                stageKey: nextStageKey,
                checkpointId: undefined,
                threadId: result.resultThreadId ?? activeThread.id,
              }, { replace: true });
            }
          }}
          onConflict={() => void openRoute(currentLocation, { replace: true })}
        />
        <section className="stage-memo" aria-labelledby="stage-memo-heading">
          <div>
            <p className="card-kicker">阶段备忘</p>
            <h2 id="stage-memo-heading">当前浏览位置的未提交笔记</h2>
          </div>
          <label className="draft-field">阶段草稿
            <textarea aria-label="阶段草稿" value={draft} onChange={(event) => {
              setDraft(event.target.value);
              writeDraft(manifest.product.id, currentDraftPath, event.target.value);
            }} placeholder="未提交内容只保存在当前浏览器" />
          </label>
          {branchControls}
        </section>
      </> : <article className="workspace-card">
        <div className="card-rule" aria-hidden="true" />
        <p className="card-kicker">{activeStage.status === 'not_started' ? '提前讨论' : '阶段工作区'}</p>
        <h2>{activeStage.status === 'not_started' ? '现在可以讨论，但不会提前推进状态' : '围绕当前阶段整理材料与判断'}</h2>
        <p>选择或创建一个线程后即可开始持久化对话。普通消息只影响线程；共享状态通过受控动作和新检查点推进。</p>
        <div className="checkpoint-row">
          <span>浏览检查点</span>
          <strong>{String(workspace.selectedCheckpoint.version).padStart(2, '0')} · {activeStage.internalState}</strong>
        </div>
        <label className="draft-field">阶段草稿
          <textarea aria-label="阶段草稿" value={draft} onChange={(event) => {
            setDraft(event.target.value);
            writeDraft(manifest.product.id, currentDraftPath, event.target.value);
          }} placeholder="未提交内容只保存在当前浏览器" />
        </label>
        {branchControls}
      </article>}

      <footer className="workspace-footer"><span>阶段自由浏览</span><span>状态只向前追加</span><span>历史改动派生路线</span></footer>
    </main>

    <aside className="threads" data-testid="thread-slot">
      <div className="section-heading"><p className="eyebrow">Threads</p><button className="icon-button" type="button" aria-label="新建线程" onClick={() => setShowThreadForm(true)}>＋</button></div>
      <p className="thread-stage-label">{activeStage.label} · {workspace.threads.length} 个讨论</p>
      {showThreadForm && <form className="inline-form thread-form" onSubmit={async (event) => {
        event.preventDefault();
        if (threadSubmission.current) return;
        threadSubmission.current = true;
        setThreadSubmitting(true);
        setError('');
        try {
          const created = await createThread(workspace.route.id, { stageKey: activeStage.stageKey, title: threadTitle });
          setWorkspace((current) => {
            if (!current || current.route.id !== created.routeId || current.selectedStageKey !== created.stageKey) return current;
            if (current.threads.some((item) => item.id === created.id)) return current;
            return { ...current, threads: [created, ...current.threads] };
          });
          setThreadTitle('');
          setThreadRename(created.title);
          setShowThreadForm(false);
          selectLocalLocation({ ...currentLocation, threadId: created.id });
        } catch {
          setError('线程没有创建，请检查标题后重试。');
        } finally {
          threadSubmission.current = false;
          setThreadSubmitting(false);
        }
      }}>
        <label>线程标题<input value={threadTitle} onChange={(event) => setThreadTitle(event.target.value)} required maxLength={120} autoFocus /></label>
        <div><button type="submit" disabled={threadSubmitting}>{threadSubmitting ? '正在创建…' : '创建线程'}</button><button type="button" disabled={threadSubmitting} onClick={() => setShowThreadForm(false)}>取消</button></div>
      </form>}
      <div className="thread-list">
        {workspace.threads.map((item) => <button
          type="button"
          key={item.id}
          aria-label={item.title}
          className={item.id === selectedThreadId ? 'thread-card active-thread' : 'thread-card'}
          onClick={() => {
            setThreadRename(item.title);
            selectLocalLocation({ ...currentLocation, threadId: item.id });
          }}
        ><span className="thread-meta">{workspace.route.name} · {activeStage.label}</span><strong>{item.title}</strong><small>独立阶段讨论</small></button>)}
        {workspace.threads.length === 0 && <p className="thread-empty">这个阶段还没有线程。可以提前开一个讨论，不会改变路线状态。</p>}
      </div>
      {!showThreadForm && <button type="button" className="new-thread-button" onClick={() => setShowThreadForm(true)}>＋ 新建线程</button>}
      {activeThread && <form className="thread-manage" onSubmit={async (event) => {
        event.preventDefault();
        setError('');
        try {
          await updateThread(activeThread.id, { title: threadRename });
          await openRoute(currentLocation, {
            replace: true,
            failureMessage: '线程名称已保存，但工作区同步失败，请重新打开。',
          });
        } catch {
          setError('线程名称没有保存，请稍后重试。');
        }
      }}>
        <label>线程名称<input value={threadRename} onChange={(event) => setThreadRename(event.target.value)} /></label>
        <div><button type="submit">保存名称</button><button type="button" onClick={async () => {
          setError('');
          try {
            await updateThread(activeThread.id, { status: 'archived' });
            await openRoute({ ...currentLocation, threadId: undefined }, {
              replace: true,
              failureMessage: '线程已归档，但工作区同步失败，请重新打开。',
            });
          } catch {
            setError('线程没有归档，请稍后重试。');
          }
        }}>归档线程</button></div>
      </form>}
      <p className="thread-note">同一阶段可以并行讨论多个问题。采纳与推进都会留下不可变检查点。</p>
    </aside>
  </div>;
}
