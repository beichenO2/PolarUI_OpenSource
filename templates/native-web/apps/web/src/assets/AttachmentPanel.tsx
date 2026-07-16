import { useCallback, useEffect, useState } from 'react';
import {
  downloadUrl,
  listThreadAttachments,
  uploadAttachment,
  type WorkflowAsset,
} from './api';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function AttachmentPanel({ threadId, revision = 0 }: { threadId: string; revision?: number }) {
  const [attachments, setAttachments] = useState<WorkflowAsset[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try {
      setAttachments(await listThreadAttachments(threadId));
      setError('');
    } catch {
      setError('附件暂时无法载入。');
    }
  }, [threadId]);

  useEffect(() => { void reload(); }, [reload, revision]);

  return <section className="attachment-panel" aria-labelledby="attachment-heading">
    <div className="asset-heading">
      <h3 id="attachment-heading">附件</h3>
      <button type="button" onClick={reload}>刷新</button>
    </div>
    <label className="asset-upload">添加附件<input type="file" disabled={busy} onChange={async (event) => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      setBusy(true);
      setError('');
      try {
        await uploadAttachment(threadId, file);
        await reload();
      } catch {
        setError('附件没有上传，请确认文件小于 25 MB。');
      } finally {
        setBusy(false);
      }
    }} /></label>
    <div className="asset-list">
      {attachments.map((attachment) => <a
        key={attachment.id}
        href={downloadUrl(attachment)}
        className="asset-row"
      >
        <span><strong>{attachment.filename}</strong><small>讨论附件</small></span>
        <span>{formatSize(attachment.byteSize)}</span>
      </a>)}
      {attachments.length === 0 && <p>还没有附件。</p>}
    </div>
    {error && <p className="command-error" role="alert">{error}</p>}
  </section>;
}
