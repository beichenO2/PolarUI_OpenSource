import { useEffect, useId, useRef, useState } from 'react';
import type { WorkflowConversation } from '../domain/api';

type MaybePromise = Promise<void> | void;

export interface ConversationSwitcherProps {
  conversations: WorkflowConversation[];
  selectedConversationId?: string;
  virtualConversationId?: string;
  routeName: string;
  onSelectConversation(conversationId: string): MaybePromise;
  onNewConversation(): MaybePromise;
  onRenameConversation(conversationId: string, title: string): MaybePromise;
  onArchiveConversation(conversationId: string): MaybePromise;
}

const statusLabel = (status: WorkflowConversation['status']) => (
  status === 'active' ? '进行中' : status === 'initializing' ? '初始化中' : '已归档'
);

const activityLabel = (updatedAt: string) => new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(updatedAt));

export function ConversationSwitcher({
  conversations,
  selectedConversationId,
  virtualConversationId,
  routeName,
  onSelectConversation,
  onNewConversation,
  onRenameConversation,
  onArchiveConversation,
}: ConversationSwitcherProps) {
  const [renamingId, setRenamingId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState('');
  const headingId = useId();
  const renameTriggers = useRef(new Map<string, HTMLButtonElement>());
  const restoreRenameFocusId = useRef<string | undefined>(undefined);
  const selected = conversations.find(({ id }) => id === selectedConversationId);
  const currentTitle = virtualConversationId
    ? (virtualConversationId.includes(':primary:') ? '主 Conversation' : '未命名 Conversation')
    : selected?.title ?? '主 Conversation';

  useEffect(() => {
    if (renamingId || !restoreRenameFocusId.current) return;
    renameTriggers.current.get(restoreRenameFocusId.current)?.focus();
    restoreRenameFocusId.current = undefined;
  }, [renamingId]);

  const finishRename = (conversationId: string) => {
    restoreRenameFocusId.current = conversationId;
    setRenamingId(undefined);
  };

  const saveRename = async (conversationId: string) => {
    const title = renameDraft.trim();
    if (!title || busyId) return;
    setBusyId(conversationId);
    setError('');
    try {
      await onRenameConversation(conversationId, title);
      finishRename(conversationId);
    } catch {
      setError('Conversation 名称没有保存，请稍后重试。');
    } finally {
      setBusyId(undefined);
    }
  };

  return <section className="conversation-switcher" aria-labelledby={headingId}>
    <header className="conversation-switcher-header">
      <div>
        <p className="eyebrow">Conversation</p>
        <h2 id={headingId}>{currentTitle}</h2>
      </div>
      <button type="button" className="icon-button" aria-label="新建 Conversation" onClick={onNewConversation}>＋</button>
    </header>
    <div className="conversation-list" role="list" aria-label="Conversations">
      {virtualConversationId && <div className="conversation-card active-conversation" role="listitem">
        <strong>{currentTitle}</strong>
        <span>{routeName} · 等待首条 Input</span>
      </div>}
      {conversations.map((item) => <div className="conversation-card" role="listitem" key={item.id}>
        {renamingId === item.id ? <label>
          <span className="sr-only">重命名 Conversation</span>
          <input
            aria-label="重命名 Conversation"
            value={renameDraft}
            maxLength={120}
            autoFocus
            disabled={busyId === item.id}
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
            aria-current={item.id === selectedConversationId ? 'page' : undefined}
            onClick={() => onSelectConversation(item.id)}
          >
            <strong>{item.title}</strong>
            <span>{routeName} · {statusLabel(item.status)}</span>
            <small>{activityLabel(item.updatedAt)}</small>
          </button>
          <div className="conversation-card-actions">
            <button
              ref={(node) => {
                if (node) renameTriggers.current.set(item.id, node);
                else renameTriggers.current.delete(item.id);
              }}
              type="button"
              aria-label={`重命名 ${item.title}`}
              onClick={() => {
                setRenameDraft(item.title);
                setRenamingId(item.id);
                setError('');
              }}
            >重命名</button>
            <details>
              <summary aria-label={`查看 ${item.title} 信息`}>信息</summary>
              <p>ID: {item.id}</p>
              <p>Route: {routeName}</p>
              <p>状态: {statusLabel(item.status)}</p>
            </details>
            <button
              type="button"
              aria-label={`归档 ${item.title}`}
              disabled={Boolean(busyId)}
              onClick={async () => {
                setBusyId(item.id);
                setError('');
                try {
                  await onArchiveConversation(item.id);
                } catch {
                  setError('Conversation 没有归档，请稍后重试。');
                } finally {
                  setBusyId(undefined);
                }
              }}
            >归档</button>
          </div>
        </>}
      </div>)}
    </div>
    {error && <p className="domain-error" role="alert">{error}</p>}
  </section>;
}
