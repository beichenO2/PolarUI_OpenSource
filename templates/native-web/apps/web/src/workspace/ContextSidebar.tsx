import { useEffect, useRef, useState } from 'react';
import {
  createContext,
  listContexts,
  renameContext,
  type WorkflowContext,
} from '../domain/api';

type MaybePromise = Promise<void> | void;

export interface ContextSidebarProps {
  contexts?: WorkflowContext[];
  selectedContextId?: string;
  onSelectContext(contextId: string): MaybePromise;
  onCreateContext?(title: string): MaybePromise;
  onRenameContext?(contextId: string, title: string): MaybePromise;
  onImport?(): void;
}

export function ContextSidebar({
  contexts: controlledContexts,
  selectedContextId,
  onSelectContext,
  onCreateContext,
  onRenameContext,
  onImport,
}: ContextSidebarProps) {
  const [loadedContexts, setLoadedContexts] = useState<WorkflowContext[]>(controlledContexts ?? []);
  const contexts = controlledContexts ?? loadedContexts;
  const [showActions, setShowActions] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [renamingId, setRenamingId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const renameTriggers = useRef(new Map<string, HTMLButtonElement>());
  const restoreRenameFocusId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (controlledContexts) {
      setLoadedContexts(controlledContexts);
      setError('');
      return;
    }
    let current = true;
    setError('');
    void listContexts()
      .then(({ contexts: next }) => {
        if (!current) return;
        setLoadedContexts(next);
        setError('');
      })
      .catch(() => { if (current) setError('Context 列表暂时无法载入。'); });
    return () => { current = false; };
  }, [controlledContexts, selectedContextId]);

  useEffect(() => {
    if (renamingId || !restoreRenameFocusId.current) return;
    renameTriggers.current.get(restoreRenameFocusId.current)?.focus();
    restoreRenameFocusId.current = undefined;
  }, [renamingId]);

  const finishRename = (contextId: string) => {
    restoreRenameFocusId.current = contextId;
    setRenamingId(undefined);
  };

  const saveRename = async (contextId: string) => {
    const title = renameDraft.trim();
    if (!title || busy) return;
    setBusy(true);
    setError('');
    try {
      if (onRenameContext) await onRenameContext(contextId, title);
      else await renameContext(contextId, { title });
      if (!mounted.current) return;
      if (!controlledContexts) {
        setLoadedContexts((current) => current.map((item) => (
          item.id === contextId ? { ...item, title } : item
        )));
      }
      finishRename(contextId);
    } catch {
      if (!mounted.current) return;
      setError('Context 名称没有保存，请稍后重试。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return <aside className="navigator context-sidebar" aria-label="Context">
    <div className="section-heading">
      <p className="eyebrow">Context</p>
      <span>{String(contexts.length).padStart(2, '0')}</span>
    </div>
    <div className="context-list">
      {contexts.map((item, index) => <div className="context-sidebar-item" key={item.id}>
        {renamingId === item.id ? <label>
          <span className="sr-only">重命名 Context</span>
          <input
            aria-label="重命名 Context"
            value={renameDraft}
            maxLength={120}
            autoFocus
            disabled={busy}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void saveRename(item.id);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                finishRename(item.id);
              }
            }}
          />
        </label> : <>
          <button
            type="button"
            className={item.id === selectedContextId ? 'context-card active-context' : 'context-card'}
            aria-current={item.id === selectedContextId ? 'page' : undefined}
            onClick={() => onSelectContext(item.id)}
          >
            <span className="context-index">{String(index + 1).padStart(2, '0')}</span>
            <span><strong>{item.title}</strong><small>{item.id === selectedContextId ? '当前' : '打开'}</small></span>
          </button>
          <button
            ref={(node) => {
              if (node) renameTriggers.current.set(item.id, node);
              else renameTriggers.current.delete(item.id);
            }}
            type="button"
            className="icon-button"
            aria-label={`重命名 ${item.title}`}
            onClick={() => {
              setRenameDraft(item.title);
              setRenamingId(item.id);
              setError('');
            }}
          >编辑</button>
        </>}
      </div>)}
      {contexts.length === 0 && <p>首条 Input 会自动建立 Context。</p>}
    </div>

    <button
      type="button"
      className="new-context-button"
      aria-expanded={showActions}
      onClick={() => setShowActions((current) => !current)}
    >更多 Context 操作</button>
    {showActions && <div className="context-secondary-actions">
      <button type="button" onClick={() => {
        setShowActions(false);
        setShowCreate(true);
      }}>新建 Context</button>
      <button type="button" onClick={() => {
        setShowActions(false);
        onImport?.();
      }}>导入 Context</button>
    </div>}
    {showCreate && <form className="inline-form context-form" onSubmit={async (event) => {
      event.preventDefault();
      const title = createTitle.trim();
      if (!title || busy) return;
      setBusy(true);
      setError('');
      try {
        if (onCreateContext) {
          await onCreateContext(title);
        } else {
          const created = await createContext(title);
          if (!mounted.current) return;
          setLoadedContexts((current) => [created.context, ...current]);
          await onSelectContext(created.context.id);
        }
        if (!mounted.current) return;
        setCreateTitle('');
        setShowCreate(false);
      } catch {
        if (!mounted.current) return;
        setError('Context 没有创建，请检查名称后重试。');
      } finally {
        if (mounted.current) setBusy(false);
      }
    }}>
      <label>Context 名称
        <input
          aria-label="Context 名称"
          value={createTitle}
          onChange={(event) => setCreateTitle(event.target.value)}
          maxLength={120}
          autoFocus
          required
        />
      </label>
      <div>
        <button type="submit" disabled={busy || !createTitle.trim()}>创建</button>
        <button type="button" disabled={busy} onClick={() => setShowCreate(false)}>取消</button>
      </div>
    </form>}
    {error && <p className="domain-error" role="alert">{error}</p>}
  </aside>;
}
