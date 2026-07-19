import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadUrl } from '../assets/api';
import type { WorkflowCheckpoint } from '../domain/api';
import { StageProjectionPanel } from '../stages/StageProjectionPanel';

const reasonLabels: Record<WorkflowCheckpoint['reason'], string> = {
  bootstrap: '建立路线',
  branch: '来源版本',
  workflow_action: 'Workflow 更新',
};

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function workflowRevision(checkpoint: WorkflowCheckpoint) {
  return checkpoint.snapshot.workflowRevision ?? '未记录';
}

function sourceCommandId(checkpoint: WorkflowCheckpoint) {
  if (checkpoint.snapshot.sourceCommandId) return checkpoint.snapshot.sourceCommandId;
  const state = checkpoint.snapshot.workflowState;
  const compatibility = state.legacyCompatibility;
  if (typeof compatibility !== 'object' || compatibility === null ||
      !('command' in compatibility) || typeof compatibility.command !== 'object' ||
      compatibility.command === null || !('id' in compatibility.command)) return undefined;
  return typeof compatibility.command.id === 'string' ? compatibility.command.id : undefined;
}

export function VersionArchive({
  checkpoints,
  routeName,
  headCheckpointId,
  initialCheckpointId,
  onClose,
  onSelectCheckpoint,
}: {
  checkpoints: WorkflowCheckpoint[];
  routeName: string;
  headCheckpointId: string;
  initialCheckpointId?: string;
  onClose(): void;
  onSelectCheckpoint(checkpointId: string): void;
}) {
  const ordered = useMemo(
    () => [...checkpoints].sort((left, right) => right.version - left.version),
    [checkpoints],
  );
  const initialId = initialCheckpointId && ordered.some(({ id }) => id === initialCheckpointId)
    ? initialCheckpointId
    : ordered.some(({ id }) => id === headCheckpointId)
      ? headCheckpointId
      : ordered[0]?.id ?? '';
  const [selectedId, setSelectedId] = useState(initialId);
  const [copiedArtifactId, setCopiedArtifactId] = useState<string>();
  const [copyErrorArtifactId, setCopyErrorArtifactId] = useState<string>();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null | undefined>(undefined);
  if (returnFocusRef.current === undefined) {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const selected = ordered.find(({ id }) => id === selectedId) ?? ordered[0];
  const sourceCommand = selected ? sourceCommandId(selected) : undefined;

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const requestClose = () => {
    const returnFocus = returnFocusRef.current;
    onCloseRef.current();
    queueMicrotask(() => returnFocus?.focus());
  };

  const selectLocalCheckpoint = (checkpointId: string) => {
    if (!ordered.some(({ id }) => id === checkpointId)) return;
    setSelectedId(checkpointId);
    setCopiedArtifactId(undefined);
    setCopyErrorArtifactId(undefined);
  };

  const copyArtifactLink = async (artifactId: string, url: string) => {
    setCopiedArtifactId(undefined);
    setCopyErrorArtifactId(undefined);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(url);
      setCopiedArtifactId(artifactId);
    } catch {
      setCopyErrorArtifactId(artifactId);
    }
  };

  const leaveArchiveAt = (checkpointId: string) => {
    onSelectCheckpoint(checkpointId);
    onCloseRef.current();
  };

  return <div className="modal-backdrop">
    <section
      className="version-archive"
      role="dialog"
      aria-modal="true"
      aria-labelledby="version-archive-heading"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        requestClose();
      }}
    >
      <header className="version-archive-header">
        <div><p className="eyebrow">{routeName}</p><h2 id="version-archive-heading">版本归档</h2></div>
        <button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭版本归档" onClick={requestClose}>×</button>
      </header>
      <div className="version-archive-body">
        <nav className="version-list" aria-label="归档版本">
          {ordered.map((checkpoint) => <button
            type="button"
            key={checkpoint.id}
            className={checkpoint.id === selected?.id ? 'version-item active' : 'version-item'}
            aria-current={checkpoint.id === selected?.id ? 'page' : undefined}
            onClick={() => selectLocalCheckpoint(checkpoint.id)}
          >
            <strong>版本 {String(checkpoint.version).padStart(2, '0')}</strong>
            <span>{new Date(checkpoint.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
          </button>)}
        </nav>

        {selected ? <div className="version-detail">
          <div className="version-detail-heading">
            <div>
              <p className="eyebrow">{reasonLabels[selected.reason]}</p>
              <h3>版本 {String(selected.version).padStart(2, '0')}</h3>
            </div>
            <span>{selected.id === headCheckpointId ? '当前版本' : '历史快照'}</span>
          </div>

          <section aria-labelledby="version-workflow-heading">
            <div className="version-section-heading">
              <h4 id="version-workflow-heading">Workflow 状态</h4>
              <span>{workflowRevision(selected)}</span>
            </div>
            <pre>{JSON.stringify(selected.snapshot.workflowState, null, 2)}</pre>
          </section>

          {selected.snapshot.stageProjection && <StageProjectionPanel
            projection={selected.snapshot.stageProjection}
            onSelectCheckpoint={selectLocalCheckpoint}
          />}

          <section aria-labelledby="version-causality-heading">
            <div className="version-section-heading"><h4 id="version-causality-heading">版本因果</h4></div>
            <dl className="version-stage-list">
              <div><dt>父 Checkpoint</dt><dd>{selected.parentCheckpointId ?? '无（路线起点）'}</dd></div>
              {sourceCommand && <div><dt>来源 Command</dt><dd>{sourceCommand}</dd></div>}
            </dl>
          </section>

          <section aria-labelledby="version-memory-heading">
            <div className="version-section-heading">
              <h4 id="version-memory-heading">记忆引用</h4>
              <span>{selected.snapshot.memoryReferences.length}</span>
            </div>
            {selected.snapshot.memoryReferences.length > 0
              ? <dl className="version-stage-list">
                {selected.snapshot.memoryReferences.map((reference) => <div
                  key={`${reference.memoryId}:${reference.version}`}
                >
                  <dt>{reference.memoryId}</dt><dd>版本 {reference.version}</dd>
                </div>)}
              </dl>
              : <p>此版本没有记忆引用。</p>}
          </section>

          <section className="version-artifacts" aria-labelledby="version-artifacts-heading">
            <div className="version-section-heading">
              <h4 id="version-artifacts-heading">成果</h4>
              <span>{selected.snapshot.artifacts.length}</span>
            </div>
            <div className="version-artifact-list">
              {selected.snapshot.artifacts.map((artifact) => {
                const url = downloadUrl({
                  kind: 'artifact',
                  id: artifact.id,
                  filename: artifact.filename,
                  mediaType: artifact.media_type,
                  byteSize: artifact.byte_size,
                  sha256: artifact.sha256,
                  createdAt: artifact.created_at,
                });
                return <article key={artifact.id}>
                  <a className="download-target" href={url} aria-label={`下载${artifact.filename}`}>
                    <span>
                      <strong>{artifact.filename}</strong>
                      <small>{artifact.stage_key ?? artifact.media_type}</small>
                    </span>
                    <span>{size(artifact.byte_size)}</span>
                  </a>
                  <button type="button" aria-label={`复制${artifact.filename}链接`} onClick={() => {
                    void copyArtifactLink(artifact.id, url);
                  }}>{copiedArtifactId === artifact.id ? '已复制' : '复制链接'}</button>
                  {copyErrorArtifactId === artifact.id && <p role="alert">链接复制失败，请重试。</p>}
                </article>;
              })}
              {selected.snapshot.artifacts.length === 0 && <p>此版本没有成果。</p>}
            </div>
          </section>

          <button
            type="button"
            className="primary-action"
            onClick={() => leaveArchiveAt(selected.id)}
          >{selected.id === headCheckpointId ? '返回当前版本' : '在此版本继续'}</button>
        </div> : <p className="version-empty">这条路线还没有归档版本。</p>}
      </div>
    </section>
  </div>;
}
