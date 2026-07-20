import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  MemoryApiError,
  invalidateMemory,
  listMemories,
  listMemoryVersions,
  reviseMemory,
  type MemoryItem,
  type MemoryScope,
} from './api';

const scopeDescription: Record<MemoryScope, string> = {
  context: '只作用于当前 Context，并为后续处理提供持续约束。',
  user: '跨 Context 生效，用于形成长期的用户模型。',
};

function jsonValue(value: unknown) {
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? 'undefined' : serialized;
}

function sourceLabel(item: MemoryItem) {
  return [item.source.kind, item.source.commandId, item.source.conversationId]
    .filter(Boolean)
    .join(' · ');
}

function impactLabel(item: MemoryItem) {
  return item.impactScope.contextIds === 'all'
    ? '全部 Context'
    : item.impactScope.contextIds.join('、') || '未声明';
}

function MemoryMetadata({ item }: { item: MemoryItem }) {
  return <>
    <pre>{jsonValue(item.value)}</pre>
    <dl>
      <div><dt>状态</dt><dd>{item.status}</dd></div>
      <div><dt>来源</dt><dd>{sourceLabel(item)}</dd></div>
      <div><dt>创建时间</dt><dd><time dateTime={item.createdAt}>{item.createdAt}</time></dd></div>
      <div><dt>更新时间</dt><dd><time dateTime={item.updatedAt}>{item.updatedAt}</time></dd></div>
      <div><dt>版本</dt><dd>版本 {item.version}</dd></div>
      <div><dt>影响范围</dt><dd>{impactLabel(item)}</dd></div>
      <div><dt>证据</dt><dd>{item.evidence.length > 0
        ? item.evidence.map((evidence) => [evidence.kind, evidence.id, evidence.excerpt]
          .filter(Boolean).join(' · ')).join('；')
        : '无'}</dd></div>
    </dl>
  </>;
}

export function HistoricalMemoryPanel({
  ownerKey,
  contextId,
  checkpointId,
  memoryReferences,
  scope,
}: {
  ownerKey: string;
  contextId?: string;
  checkpointId: string;
  memoryReferences: ReadonlyArray<{ memoryId: string; version: number }>;
  scope: MemoryScope;
}) {
  const referencesIdentity = memoryReferences
    .map(({ memoryId, version }) => `${encodeURIComponent(memoryId)}@${version}`)
    .join(',');
  const scopeIdentity = [ownerKey, contextId ?? '', checkpointId, scope, referencesIdentity].join('|');
  const [retryRevision, setRetryRevision] = useState(0);
  const [view, setView] = useState<{
    scopeIdentity: string;
    state: 'loading' | 'ready' | 'error';
    items: MemoryItem[];
  }>(() => ({ scopeIdentity, state: 'loading', items: [] }));
  const visibleView = view.scopeIdentity === scopeIdentity
    ? view
    : { scopeIdentity, state: 'loading' as const, items: [] as MemoryItem[] };

  useEffect(() => {
    const controllers = memoryReferences.map(() => new AbortController());
    let active = true;
    setView({ scopeIdentity, state: 'loading', items: [] });
    void Promise.all(memoryReferences.map(async (reference, index) => {
      const versions = await listMemoryVersions(reference.memoryId, controllers[index]!.signal);
      const exact = versions.find((version) =>
        version.id === reference.memoryId && version.version === reference.version);
      if (!exact) throw new Error('HISTORICAL_MEMORY_VERSION_NOT_FOUND');
      return exact;
    })).then((versions) => {
      if (!active) return;
      const items = versions.filter((item) => scope === 'user'
        ? item.scope === 'user'
        : item.scope === 'context' && item.contextId === contextId);
      setView({ scopeIdentity, state: 'ready', items });
    }).catch(() => {
      if (!active || controllers.some(({ signal }) => signal.aborted)) return;
      setView({ scopeIdentity, state: 'error', items: [] });
    });
    return () => {
      active = false;
      controllers.forEach((controller) => controller.abort());
    };
  }, [scopeIdentity, retryRevision]);

  return <section className="memory-panel" aria-label={scope === 'context' ? '情景记忆' : '用户记忆'}>
    <p className="memory-scope-description">{scopeDescription[scope]}</p>
    {visibleView.state === 'loading' && <p role="status">正在载入历史记忆…</p>}
    {visibleView.state === 'error' && <p role="alert">
      历史记忆暂时无法载入。
      {' '}<button type="button" onClick={() => setRetryRevision((current) => current + 1)}>重试载入</button>
    </p>}
    {visibleView.state === 'ready' && visibleView.items.length === 0 && <p>此版本在当前范围没有记忆。</p>}
    <div className="memory-list">
      {visibleView.items.map((item) => <article key={`${item.id}:${item.version}`} className="memory-card">
        <header><h3>{item.key}</h3></header>
        <MemoryMetadata item={item} />
      </article>)}
    </div>
  </section>;
}

type EditDialog = {
  scopeIdentity: string;
  kind: 'revise' | 'invalidate';
  item: MemoryItem;
  valueText: string;
  reason: string;
  conflict: 'none' | 'refreshed' | 'refresh_failed';
  latestItem?: MemoryItem;
};

type DialogReturnFocus = {
  actionKey: string;
  memoryId: string;
  scopeIdentity: string;
  fallback: HTMLButtonElement;
};

export function MemoryPanel({
  ownerKey,
  contextId,
  scope: controlledScope,
  hideScopeTabs = false,
  revision = 0,
}: {
  ownerKey: string;
  contextId?: string;
  scope?: MemoryScope;
  hideScopeTabs?: boolean;
  revision?: string | number;
}) {
  const [internalScope, setInternalScope] = useState<MemoryScope>('context');
  const scope = controlledScope ?? internalScope;
  const inputKey = scope === 'user' ? 'user' : `context:${contextId ?? ''}`;
  const scopeIdentity = `${ownerKey}|${inputKey}|${String(revision)}`;
  const [itemsState, setItemsState] = useState<{
    scopeIdentity: string;
    items: MemoryItem[];
  }>(() => ({ scopeIdentity, items: [] }));
  const [loading, setLoading] = useState(false);
  const [errorState, setErrorState] = useState(() => ({ scopeIdentity, message: '' }));
  const [histories, setHistories] = useState(() => new Map<string, MemoryItem[]>());
  const [dialog, setDialog] = useState<EditDialog>();
  const [actionErrorState, setActionErrorState] = useState(() => ({ scopeIdentity, message: '' }));
  const [actionBusy, setActionBusy] = useState(false);
  const loadEpoch = useRef(0);
  const actionEpoch = useRef(0);
  const actionInFlight = useRef<{ token: number; controller: AbortController }>();
  const dialogEditorRef = useRef<HTMLTextAreaElement>(null);
  const memoryPanelRef = useRef<HTMLElement>(null);
  const dialogReturnFocusRef = useRef<DialogReturnFocus | null>(null);
  const pendingDialogReturnFocusRef = useRef<DialogReturnFocus | null>(null);
  const historyRequestEpoch = useRef(0);
  const historyRequests = useRef(new Map<string, {
    token: number;
    controller: AbortController;
  }>());
  const requestControllers = useRef(new Set<AbortController>());
  const fetchContextId = scope === 'context' ? contextId : undefined;
  const items = itemsState.scopeIdentity === scopeIdentity ? itemsState.items : [];
  const error = errorState.scopeIdentity === scopeIdentity ? errorState.message : '';
  const actionError = actionErrorState.scopeIdentity === scopeIdentity
    ? actionErrorState.message
    : '';
  const visibleDialog = dialog?.scopeIdentity === scopeIdentity ? dialog : undefined;
  const setItems = (next: MemoryItem[]) => setItemsState({ scopeIdentity, items: next });
  const setError = (message: string) => setErrorState({ scopeIdentity, message });
  const setActionError = (message: string) => setActionErrorState({ scopeIdentity, message });

  useLayoutEffect(() => {
    setActionBusy(false);
    return () => {
      actionEpoch.current += 1;
      actionInFlight.current?.controller.abort();
      actionInFlight.current = undefined;
    };
  }, [inputKey, ownerKey, revision]);

  const trackController = useCallback(() => {
    const controller = new AbortController();
    requestControllers.current.add(controller);
    return controller;
  }, []);

  const releaseController = useCallback((controller: AbortController) => {
    requestControllers.current.delete(controller);
  }, []);

  const loadCurrent = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    if (scope === 'context' && !fetchContextId) {
      setItems([]);
      setLoading(false);
      setError('');
      return [] as MemoryItem[];
    }
    const controller = trackController();
    setItems([]);
    setLoading(true);
    setError('');
    try {
      const loaded = await listMemories(
        scope === 'user' ? { scope: 'user' } : { scope: 'context', contextId: fetchContextId! },
        controller.signal,
      );
      if (controller.signal.aborted || epoch !== loadEpoch.current) return [];
      setItems(loaded);
      return loaded;
    } catch (reason) {
      if (controller.signal.aborted || epoch !== loadEpoch.current) return [];
      setError(reason instanceof MemoryApiError
        ? `记忆暂时无法载入（${reason.code}）。`
        : '记忆暂时无法载入。');
      return [];
    } finally {
      releaseController(controller);
      if (!controller.signal.aborted && epoch === loadEpoch.current) setLoading(false);
    }
  }, [fetchContextId, inputKey, releaseController, scope, scopeIdentity, trackController]);

  useEffect(() => {
    setHistories(new Map());
    setDialog(undefined);
    setActionError('');
    void loadCurrent();
    return () => {
      loadEpoch.current += 1;
      for (const request of historyRequests.current.values()) request.controller.abort();
      historyRequests.current.clear();
      for (const controller of requestControllers.current) controller.abort();
      requestControllers.current.clear();
    };
  }, [inputKey, loadCurrent, ownerKey, revision]);

  useEffect(() => {
    if (!visibleDialog) return;
    dialogEditorRef.current?.focus();
  }, [visibleDialog?.item.id, visibleDialog?.kind, visibleDialog?.scopeIdentity]);

  useEffect(() => {
    const pending = pendingDialogReturnFocusRef.current;
    if (visibleDialog || loading || !pending) return;
    if (pending.scopeIdentity !== scopeIdentity) {
      pendingDialogReturnFocusRef.current = null;
      return;
    }
    const actionTriggers = Array.from(memoryPanelRef.current?.querySelectorAll<HTMLButtonElement>(
      '[data-memory-action]',
    ) ?? []);
    const currentTrigger = actionTriggers.find(
      (candidate) => candidate.dataset.memoryAction === pending.actionKey,
    );
    const sameMemoryTrigger = actionTriggers.find(
      (candidate) => candidate.dataset.memoryAction === `revise:${pending.memoryId}`,
    );
    const target = currentTrigger ?? sameMemoryTrigger ??
      (pending.fallback.isConnected ? pending.fallback : undefined);
    if (!target) {
      pendingDialogReturnFocusRef.current = null;
      return;
    }
    target.focus();
    pendingDialogReturnFocusRef.current = null;
  }, [items, loading, scopeIdentity, visibleDialog]);

  const clearHistory = (memoryId: string) => {
    setHistories((current) => {
      if (!current.has(memoryId)) return current;
      const next = new Map(current);
      next.delete(memoryId);
      return next;
    });
  };

  const invalidateHistory = (memoryId: string) => {
    const current = historyRequests.current.get(memoryId);
    if (current) {
      current.controller.abort();
      historyRequests.current.delete(memoryId);
    }
    clearHistory(memoryId);
  };

  const showHistory = async (item: MemoryItem) => {
    invalidateHistory(item.id);
    const controller = trackController();
    const token = ++historyRequestEpoch.current;
    historyRequests.current.set(item.id, { token, controller });
    setActionError('');
    try {
      const versions = await listMemoryVersions(item.id, controller.signal);
      const current = historyRequests.current.get(item.id);
      if (controller.signal.aborted || current?.token !== token || current.controller !== controller) return;
      setHistories((current) => new Map(current).set(item.id, versions));
    } catch (reason) {
      const current = historyRequests.current.get(item.id);
      if (!controller.signal.aborted && current?.token === token && current.controller === controller) {
        setActionError(reason instanceof MemoryApiError
          ? `版本历史无法载入（${reason.code}）。`
          : '版本历史暂时无法载入。');
      }
    } finally {
      const current = historyRequests.current.get(item.id);
      if (current?.token === token && current.controller === controller) {
        historyRequests.current.delete(item.id);
      }
      releaseController(controller);
    }
  };

  const refreshConflict = async (
    attempt: EditDialog,
    controller: AbortController,
    actionIsCurrent: () => boolean,
  ) => {
    try {
      const loaded = await listMemories(
        scope === 'user' ? { scope: 'user' } : { scope: 'context', contextId: fetchContextId! },
        controller.signal,
      );
      if (!actionIsCurrent()) return;
      const latest = loaded.find(({ id }) => id === attempt.item.id);
      if (!latest) throw new MemoryApiError('NOT_FOUND', 404);
      setItems(loaded);
      setError('');
      clearHistory(attempt.item.id);
      setDialog((current) => current?.scopeIdentity === attempt.scopeIdentity &&
        current.item.id === attempt.item.id && current.kind === attempt.kind
        ? { ...current, item: latest, latestItem: latest, conflict: 'refreshed' }
        : current);
      setActionError('版本冲突：已载入服务器最新版本，请检查后重试。');
    } catch {
      if (!actionIsCurrent()) return;
      setDialog((current) => current?.scopeIdentity === attempt.scopeIdentity &&
        current.item.id === attempt.item.id && current.kind === attempt.kind
        ? { ...current, conflict: 'refresh_failed', latestItem: undefined }
        : current);
      setActionError('版本冲突：最新记忆无法载入，请刷新后再试。');
    }
  };

  const retryConflictRefresh = async () => {
    if (!visibleDialog || visibleDialog.conflict !== 'refresh_failed' || actionInFlight.current) return;
    const attempt = visibleDialog;
    const token = ++actionEpoch.current;
    const controller = trackController();
    actionInFlight.current = { token, controller };
    setActionBusy(true);
    setActionError('');
    const actionIsCurrent = () => !controller.signal.aborted && token === actionEpoch.current;
    try {
      await refreshConflict(attempt, controller, actionIsCurrent);
    } finally {
      releaseController(controller);
      if (actionInFlight.current?.token === token) {
        actionInFlight.current = undefined;
        setActionBusy(false);
      }
    }
  };

  const closeDialog = ({
    allowBusy = false,
    preserveAction = false,
  }: {
    allowBusy?: boolean;
    preserveAction?: boolean;
  } = {}) => {
    if (!allowBusy && (actionBusy || actionInFlight.current)) return;
    pendingDialogReturnFocusRef.current = dialogReturnFocusRef.current;
    dialogReturnFocusRef.current = null;
    if (!preserveAction) actionEpoch.current += 1;
    setDialog(undefined);
    setActionError('');
  };

  const submitDialog = async () => {
    if (!visibleDialog || actionInFlight.current) return;
    const attempt = visibleDialog;
    const token = ++actionEpoch.current;
    const controller = trackController();
    actionInFlight.current = { token, controller };
    setActionBusy(true);
    const actionIsCurrent = () => !controller.signal.aborted && token === actionEpoch.current;
    setActionError('');
    try {
      if (attempt.kind === 'revise') {
        let value: unknown;
        try {
          value = JSON.parse(attempt.valueText);
        } catch {
          if (actionIsCurrent()) setActionError('请输入有效的 JSON 值。');
          return;
        }
        invalidateHistory(attempt.item.id);
        await reviseMemory(attempt.item.id, {
          value,
          expectedVersion: attempt.item.version,
        }, controller.signal);
      } else {
        const reason = attempt.reason.trim();
        if (!reason) {
          if (actionIsCurrent()) setActionError('请填写失效原因。');
          return;
        }
        invalidateHistory(attempt.item.id);
        await invalidateMemory(attempt.item.id, {
          expectedVersion: attempt.item.version,
          reason,
        }, controller.signal);
      }
      if (!actionIsCurrent()) return;
      clearHistory(attempt.item.id);
      closeDialog({ allowBusy: true, preserveAction: true });
      await loadCurrent();
    } catch (reason) {
      if (!actionIsCurrent()) return;
      if (reason instanceof MemoryApiError && reason.status === 409) {
        await refreshConflict(attempt, controller, actionIsCurrent);
      } else {
        setActionError(reason instanceof MemoryApiError
          ? `记忆没有更新（${reason.code}）。`
          : '记忆没有更新，请稍后重试。');
      }
    } finally {
      releaseController(controller);
      if (actionInFlight.current?.token === token) {
        actionInFlight.current = undefined;
        setActionBusy(false);
      }
    }
  };

  const openDialog = (
    kind: EditDialog['kind'],
    item: MemoryItem,
    trigger: HTMLButtonElement,
  ) => {
    actionEpoch.current += 1;
    dialogReturnFocusRef.current = {
      actionKey: `${kind}:${item.id}`,
      memoryId: item.id,
      scopeIdentity,
      fallback: trigger,
    };
    pendingDialogReturnFocusRef.current = null;
    setActionError('');
    setDialog({
      scopeIdentity,
      kind,
      item,
      valueText: kind === 'revise' ? jsonValue(item.value) : '',
      reason: '',
      conflict: 'none',
    });
  };

  return <section ref={memoryPanelRef} className="memory-panel" aria-label={scope === 'context' ? '情景记忆' : '用户记忆'}>
    {!hideScopeTabs && <div role="tablist" aria-label="记忆范围">
      {(['context', 'user'] as const).map((candidate) => <button
        key={candidate}
        type="button"
        role="tab"
        aria-selected={scope === candidate}
        onClick={() => setInternalScope(candidate)}
      >{candidate === 'context' ? '情景记忆' : '用户记忆'}</button>)}
    </div>}
    <p className="memory-scope-description">{scopeDescription[scope]}</p>
    {loading && <p role="status">正在载入记忆…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => void loadCurrent()}>重试载入</button></p>}
    {!loading && !error && items.length === 0 && <p>当前范围还没有记忆。</p>}
    <div className="memory-list">
      {items.map((item) => <article key={item.id} className="memory-card">
        <header><h3>{item.key}</h3></header>
        <MemoryMetadata item={item} />
        <div className="memory-actions">
          <button type="button" aria-label={`查看 ${item.key} 的完整版本历史`} onClick={() => void showHistory(item)}>
            完整版本历史
          </button>
          <button
            type="button"
            aria-label={`修正 ${item.key}`}
            data-memory-action={`revise:${item.id}`}
            onClick={(event) => openDialog('revise', item, event.currentTarget)}
          >修正</button>
          {item.status !== 'invalidated' && <button
            type="button"
            aria-label={`使 ${item.key} 失效`}
            data-memory-action={`invalidate:${item.id}`}
            onClick={(event) => openDialog('invalidate', item, event.currentTarget)}
          >失效</button>}
        </div>
        {histories.has(item.id) && <section role="region" aria-label={`${item.key} 的版本历史`}>
          <h4>完整版本历史</h4>
          {histories.get(item.id)!.map((version) => <article
            key={version.version}
            aria-label={`${item.key} 版本 ${version.version}`}
          >
            <MemoryMetadata item={version} />
          </article>)}
        </section>}
      </article>)}
    </div>
    {visibleDialog && <div className="modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${visibleDialog.kind === 'revise' ? '修正' : '使'} ${visibleDialog.item.key}${visibleDialog.kind === 'invalidate' ? ' 失效' : ''}`}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          closeDialog();
        }}
      >
        <h3>{visibleDialog.kind === 'revise' ? `修正 ${visibleDialog.item.key}` : `使 ${visibleDialog.item.key} 失效`}</h3>
        <p>基于版本 {visibleDialog.item.version}</p>
        {visibleDialog.kind === 'revise' ? <label>JSON 值
          <textarea ref={dialogEditorRef} disabled={actionBusy} aria-label="JSON 值" value={visibleDialog.valueText} onChange={(event) => {
            if (actionInFlight.current) return;
            setDialog({ ...visibleDialog, valueText: event.target.value });
          }} />
        </label> : <label>失效原因
          <textarea ref={dialogEditorRef} disabled={actionBusy} aria-label="失效原因" value={visibleDialog.reason} onChange={(event) => {
            if (actionInFlight.current) return;
            setDialog({ ...visibleDialog, reason: event.target.value });
          }} />
        </label>}
        {visibleDialog.conflict === 'refreshed' && visibleDialog.latestItem && <section aria-label="服务器最新记忆">
          <h4>服务器最新值</h4>
          <pre>{jsonValue(visibleDialog.latestItem.value)}</pre>
        </section>}
        {actionError && <p className="command-error" role="alert">{actionError}</p>}
        {visibleDialog.conflict === 'refresh_failed' && <button
          type="button"
          disabled={actionBusy}
          onClick={() => void retryConflictRefresh()}
        >重新载入最新版本</button>}
        <div>
          <button
            type="button"
            disabled={actionBusy || visibleDialog.conflict === 'refresh_failed'}
            onClick={() => void submitDialog()}
          >{visibleDialog.conflict === 'refresh_failed'
            ? '重新载入后重试'
            : visibleDialog.conflict === 'refreshed'
              ? visibleDialog.kind === 'revise' ? '重试修正' : '重试失效'
            : visibleDialog.kind === 'revise' ? '保存修正' : '确认失效'}</button>
          <button type="button" disabled={actionBusy} onClick={() => closeDialog()}>取消</button>
        </div>
      </section>
    </div>}
    {!visibleDialog && actionError && <p className="command-error" role="alert">{actionError}</p>}
  </section>;
}
