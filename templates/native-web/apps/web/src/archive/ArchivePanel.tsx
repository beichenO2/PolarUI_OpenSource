import { useEffect, useRef, useState } from 'react';
async function request(path: string) { const response = await fetch(path, { credentials: 'same-origin' }); if (!response.ok) throw new Error('ARCHIVE_UNAVAILABLE'); return response.json(); }
export function ArchivePanel({ onClose }: { onClose: () => void }) {
  const [conversations, setConversations] = useState<any[]>([]); const [selected, setSelected] = useState<any>(null); const [error, setError] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null | undefined>(undefined);
  if (returnFocusRef.current === undefined) {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => { void request('/api/archive/conversations').then((value) => setConversations(value.conversations)).catch(() => setError('历史档案暂时无法载入。')); }, []);
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);
  const requestClose = () => {
    const returnFocus = returnFocusRef.current;
    onCloseRef.current();
    queueMicrotask(() => returnFocus?.focus());
  };
  return <div
    className="archive-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label="LibreChat 历史档案"
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      requestClose();
    }}
  ><section className="archive-panel"><header><div><p className="eyebrow">只读迁移档案</p><h2>历史对话</h2></div><button ref={closeButtonRef} type="button" onClick={requestClose}>关闭</button></header>
    <div className="archive-layout"><nav aria-label="历史对话列表">{conversations.map((item) => <button type="button" key={item.id} onClick={() => void request(`/api/archive/conversations/${item.id}`).then(setSelected)}><strong>{item.title}</strong><small>{item.messageCount} 条消息 · 只读</small></button>)}{conversations.length === 0 && !error && <p>还没有导入的历史对话。</p>}</nav>
      <article className="archive-detail">{selected ? <><h3>{selected.conversation.title}</h3>{selected.messages.map((message: any) => <div key={message.id} className="archive-message"><span>{message.role}</span><p>{message.content}</p></div>)}
        {selected.attachments.length > 0 && <section className="archive-files"><h4>历史附件</h4>{selected.attachments.map((file: any) => file.status === 'ready' ? <a className="download-target" key={file.id} href={`/api/assets/archive/${file.id}/download`}>{file.filename}</a> : <span key={file.id}>{file.filename} · {file.status}</span>)}</section>}
      </> : <p>选择一条历史对话查看。导入档案只读；要继续工作，请在当前阶段创建讨论。</p>}</article></div>
    {error && <p className="command-error" role="alert">{error}</p>}</section></div>;
}
