import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  deleteStagedAttachment,
  downloadUrl,
  listConversationAttachments,
  stageAttachment,
  type StagedAttachment,
  type WorkflowAsset,
} from './api';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

interface DraftOwnerRecord {
  scope: string;
  changeStaged: (ownerKey: string, update: StagedAttachmentUpdater) => void;
  pendingOperations: number;
  error: string;
}

export type StagedAttachmentUpdater = (
  current: StagedAttachment[],
) => StagedAttachment[];

export function AttachmentPanel({
  staged: controlledStaged,
  onChange,
  conversationId,
  threadId,
  draftKey,
  revision = 0,
}: {
  staged?: StagedAttachment[];
  onChange?: (ownerKey: string, update: StagedAttachmentUpdater) => void;
  conversationId?: string;
  /** Temporary compatibility for the protected pre-conversation workspace. */
  threadId?: string;
  /** Stable identity for multiple drafts that do not have a Conversation yet. */
  draftKey?: string;
  revision?: number;
}) {
  const adoptedConversationId = conversationId ?? threadId;
  const ownerScope = conversationId
    ? `conversation:${conversationId}`
    : threadId
      ? `thread:${threadId}`
      : `draft:${draftKey ?? 'default'}`;
  const [localStagedByOwner, setLocalStagedByOwner] = useState(
    () => new Map<string, StagedAttachment[]>(),
  );
  const staged = controlledStaged ?? (localStagedByOwner.get(ownerScope) ?? []);
  const stagedRevision = staged.map((attachment) => attachment.id).join(',');
  const changeStaged = onChange ?? ((ownerKey: string, update: StagedAttachmentUpdater) => {
    setLocalStagedByOwner((currentByOwner) => {
      const current = currentByOwner.get(ownerKey) ?? [];
      const next = update(current);
      if (next === current) return currentByOwner;
      const nextByOwner = new Map(currentByOwner);
      nextByOwner.set(ownerKey, next);
      return nextByOwner;
    });
  });
  const ownerRecords = useRef(new Map<string, DraftOwnerRecord>());
  let currentOwner = ownerRecords.current.get(ownerScope);
  if (!currentOwner) {
    currentOwner = {
      scope: ownerScope,
      changeStaged,
      pendingOperations: 0,
      error: '',
    };
    ownerRecords.current.set(ownerScope, currentOwner);
  }
  currentOwner.changeStaged = changeStaged;
  for (const [scope, owner] of ownerRecords.current) {
    if (scope !== ownerScope && owner.pendingOperations === 0) ownerRecords.current.delete(scope);
  }
  const currentOwnerRef = useRef(currentOwner);
  currentOwnerRef.current = currentOwner;
  const [, renderOwnerState] = useReducer((revision: number) => revision + 1, 0);
  const refreshOwner = useCallback((owner: DraftOwnerRecord) => {
    if (currentOwnerRef.current === owner) {
      renderOwnerState();
    } else if (owner.pendingOperations === 0) {
      ownerRecords.current.delete(owner.scope);
    }
  }, []);
  const [attachments, setAttachments] = useState<WorkflowAsset[]>([]);
  const busy = currentOwner.pendingOperations > 0;
  const error = currentOwner.error;
  const reloadGeneration = useRef(0);
  const reload = useCallback(async () => {
    const owner = currentOwnerRef.current;
    const generation = ++reloadGeneration.current;
    if (!adoptedConversationId) {
      setAttachments([]);
      if (owner.error) {
        owner.error = '';
        refreshOwner(owner);
      }
      return;
    }
    try {
      const nextAttachments = await listConversationAttachments(adoptedConversationId);
      if (generation !== reloadGeneration.current) return;
      setAttachments(nextAttachments);
      if (owner.error) {
        owner.error = '';
        refreshOwner(owner);
      }
    } catch {
      if (generation !== reloadGeneration.current) return;
      owner.error = '附件暂时无法载入。';
      refreshOwner(owner);
    }
  }, [adoptedConversationId, refreshOwner]);

  useEffect(() => {
    void reload();
    return () => { reloadGeneration.current += 1; };
  }, [reload, revision, stagedRevision]);

  return <section className="attachment-panel" aria-labelledby="attachment-heading">
    <div className="asset-heading">
      <h3 id="attachment-heading">附件</h3>
      <button type="button" onClick={reload}>刷新</button>
    </div>
    <label className="asset-upload">添加附件<input type="file" disabled={busy} onChange={async (event) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      if (!file) return;
      const owner = currentOwnerRef.current;
      owner.pendingOperations += 1;
      owner.error = '';
      refreshOwner(owner);
      try {
        const attachment = await stageAttachment(file);
        owner.changeStaged(owner.scope, (current) => (
          current.some((item) => item.id === attachment.id)
            ? current
            : [...current, attachment]
        ));
        if (currentOwnerRef.current === owner) input.value = '';
      } catch {
        owner.error = '附件没有上传，请确认文件小于 25 MB。';
      } finally {
        owner.pendingOperations -= 1;
        refreshOwner(owner);
      }
    }} /></label>
    <div className="asset-list">
      {staged.map((attachment) => <div key={attachment.id} className="asset-row">
        <span><strong>{attachment.filename}</strong><small>待发送</small></span>
        <span>{formatSize(attachment.byteSize)}</span>
        <button type="button" disabled={busy} aria-label={`移除 ${attachment.filename}`} onClick={async () => {
          const owner = currentOwnerRef.current;
          owner.pendingOperations += 1;
          owner.error = '';
          refreshOwner(owner);
          try {
            await deleteStagedAttachment(attachment.id);
            owner.changeStaged(
              owner.scope,
              (current) => current.filter((item) => item.id !== attachment.id),
            );
          } catch {
            owner.error = '附件暂时无法移除。';
          } finally {
            owner.pendingOperations -= 1;
            refreshOwner(owner);
          }
        }}>移除</button>
      </div>)}
      {attachments.map((attachment) => <a
        key={attachment.id}
        href={downloadUrl(attachment)}
        className="asset-row download-target"
      >
        <span><strong>{attachment.filename}</strong><small>讨论附件</small></span>
        <span>{formatSize(attachment.byteSize)}</span>
      </a>)}
      {staged.length === 0 && attachments.length === 0 && <p>还没有附件。</p>}
    </div>
    {error && <p className="command-error" role="alert">{error}</p>}
  </section>;
}
