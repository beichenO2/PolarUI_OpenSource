import { useEffect, useState, type ComponentProps, type RefObject } from 'react';
import { AttachmentPanel } from '../assets/AttachmentPanel';
import { ThreadConversation } from '../commands/ThreadConversation';
import type { WorkflowThread } from '../domain/api';
import { ProposalPanel } from '../memory/ProposalPanel';

export function ThreadDrawer({
  threads,
  selectedThreadId,
  stageLabel,
  returnFocusRef,
  onClose,
  onSelectThread,
  onCreateThread,
  onRenameThread,
  onArchiveThread,
  conversation,
  revision = 0,
}: {
  threads: WorkflowThread[];
  selectedThreadId?: string;
  stageLabel: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSelectThread: (threadId: string) => void;
  onCreateThread: (title: string) => Promise<void> | void;
  onRenameThread: (threadId: string, title: string) => Promise<void> | void;
  onArchiveThread: (threadId: string) => Promise<void> | void;
  conversation?: ComponentProps<typeof ThreadConversation>;
  revision?: number;
}) {
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [rename, setRename] = useState(selectedThread?.title ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setRename(selectedThread?.title ?? ''), [selectedThread?.id, selectedThread?.title]);

  const close = () => {
    returnFocusRef?.current?.focus();
    onClose();
  };

  return <aside className="thread-drawer" role="dialog" aria-modal="true" aria-labelledby="thread-drawer-heading">
    <header className="thread-drawer-header">
      <div><p className="eyebrow">{stageLabel}</p><h2 id="thread-drawer-heading">阶段讨论</h2></div>
      <button type="button" className="icon-button" aria-label="关闭讨论" onClick={close}>×</button>
    </header>

    <div className="thread-drawer-nav">
      <div className="discussion-tabs" role="tablist" aria-label="当前阶段讨论">
        {threads.map((thread) => <button
          type="button"
          role="tab"
          aria-selected={thread.id === selectedThreadId}
          key={thread.id}
          onClick={() => onSelectThread(thread.id)}
        >{thread.title}</button>)}
      </div>
      {!showCreate && <button type="button" className="new-discussion-button" onClick={() => setShowCreate(true)}>新建讨论</button>}
      {showCreate && <form className="inline-form discussion-create-form" onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !title.trim()) return;
        setBusy(true);
        setError('');
        try {
          await onCreateThread(title.trim());
          setTitle('');
          setShowCreate(false);
        } catch {
          setError('讨论没有创建，请检查标题后重试。');
        } finally {
          setBusy(false);
        }
      }}>
        <label>讨论标题<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required autoFocus /></label>
        <div>
          <button type="submit" disabled={busy || !title.trim()}>{busy ? '正在创建…' : '创建讨论'}</button>
          {threads.length > 0 && <button type="button" disabled={busy} onClick={() => setShowCreate(false)}>取消</button>}
        </div>
      </form>}
    </div>

    <div className="thread-drawer-content">
      {selectedThread && conversation ? <>
        <ThreadConversation {...conversation} />
        <AttachmentPanel threadId={selectedThread.id} revision={revision} />
        <ProposalPanel threadId={selectedThread.id} revision={revision} />
        <form className="thread-manage" onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !rename.trim()) return;
          setBusy(true);
          setError('');
          try {
            await onRenameThread(selectedThread.id, rename.trim());
          } catch {
            setError('讨论名称没有保存，请稍后重试。');
          } finally {
            setBusy(false);
          }
        }}>
          <label>讨论名称<input value={rename} onChange={(event) => setRename(event.target.value)} maxLength={120} /></label>
          <div>
            <button type="submit" disabled={busy || !rename.trim()}>保存名称</button>
            <button type="button" disabled={busy} onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await onArchiveThread(selectedThread.id);
              } catch {
                setError('讨论没有归档，请稍后重试。');
              } finally {
                setBusy(false);
              }
            }}>归档讨论</button>
          </div>
        </form>
      </> : !showCreate && <div className="discussion-empty">
        <h3>选择一个讨论</h3>
        <p>继续已有讨论，或开始一个新话题。</p>
      </div>}
      {error && <p className="domain-error" role="alert">{error}</p>}
    </div>
  </aside>;
}
