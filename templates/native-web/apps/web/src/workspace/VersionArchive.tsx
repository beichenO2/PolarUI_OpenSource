import { useMemo, useState } from 'react';
import { downloadUrl } from '../assets/api';
import type { WorkflowCheckpoint } from '../domain/api';

const reasonLabels: Record<WorkflowCheckpoint['reason'], string> = {
  bootstrap: '建立路线',
  branch: '基于版本创建',
  workflow_action: '阶段更新',
};

const statusLabels = {
  not_started: '未开始',
  active: '进行中',
  completed: '已完成',
};

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function VersionArchive({ checkpoints, routeName, stageLabels, onClose, onCreateRoute }: {
  checkpoints: WorkflowCheckpoint[];
  routeName: string;
  stageLabels: Record<string, string>;
  onClose: () => void;
  onCreateRoute: (checkpointId: string, name: string) => Promise<void> | void;
}) {
  const ordered = useMemo(
    () => [...checkpoints].sort((left, right) => right.version - left.version),
    [checkpoints],
  );
  const [selectedId, setSelectedId] = useState(ordered[0]?.id ?? '');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('新路线');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = ordered.find((checkpoint) => checkpoint.id === selectedId) ?? ordered[0];

  return <div className="modal-backdrop">
    <section className="version-archive" role="dialog" aria-modal="true" aria-labelledby="version-archive-heading">
      <header className="version-archive-header">
        <div><p className="eyebrow">{routeName}</p><h2 id="version-archive-heading">版本归档</h2></div>
        <button type="button" className="icon-button" aria-label="关闭版本归档" onClick={onClose}>×</button>
      </header>
      <div className="version-archive-body">
        <nav className="version-list" aria-label="归档版本">
          {ordered.map((checkpoint) => <button
            type="button"
            key={checkpoint.id}
            className={checkpoint.id === selected?.id ? 'version-item active' : 'version-item'}
            aria-current={checkpoint.id === selected?.id ? 'true' : undefined}
            onClick={() => {
              setSelectedId(checkpoint.id);
              setShowCreate(false);
              setError('');
            }}
          >
            <strong>版本 {String(checkpoint.version).padStart(2, '0')}</strong>
            <span>{new Date(checkpoint.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
          </button>)}
        </nav>
        {selected ? <div className="version-detail">
          <div className="version-detail-heading">
            <div><p className="eyebrow">{reasonLabels[selected.reason]}</p><h3>版本 {String(selected.version).padStart(2, '0')}</h3></div>
            <span>{stageLabels[selected.stageKey] ?? selected.stageKey}</span>
          </div>
          <dl className="version-stage-list">
            {selected.snapshot.stages.map((stage) => <div key={stage.stage_key}>
              <dt>{stageLabels[stage.stage_key] ?? stage.stage_key}</dt>
              <dd>{statusLabels[stage.status]}</dd>
            </div>)}
          </dl>
          <section className="version-artifacts" aria-labelledby="version-artifacts-heading">
            <div className="version-section-heading">
              <h4 id="version-artifacts-heading">成果</h4>
              <span>{selected.snapshot.artifacts?.length ?? 0}</span>
            </div>
            <div className="version-artifact-list">
              {(selected.snapshot.artifacts ?? []).map((artifact) => <a
                key={artifact.id}
                href={downloadUrl({
                  kind: 'artifact',
                  id: artifact.id,
                  filename: artifact.filename,
                  mediaType: artifact.media_type,
                  byteSize: artifact.byte_size,
                  sha256: artifact.sha256,
                  createdAt: artifact.created_at,
                })}
              >
                <span><strong>{artifact.filename}</strong><small>{stageLabels[artifact.stage_key] ?? artifact.stage_key}</small></span>
                <span>{size(artifact.byte_size)}</span>
              </a>)}
              {(selected.snapshot.artifacts?.length ?? 0) === 0 && <p>此版本没有成果。</p>}
            </div>
          </section>
          {!showCreate && <button type="button" className="primary-action" onClick={() => setShowCreate(true)}>
            基于此版本新建路线
          </button>}
          {showCreate && <form className="inline-form version-create-form" onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError('');
            try {
              await onCreateRoute(selected.id, name);
            } catch {
              setError('路线没有创建，请稍后重试。');
            } finally {
              setBusy(false);
            }
          }}>
            <label>新路线名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus /></label>
            <div>
              <button type="submit" disabled={busy}>{busy ? '正在创建…' : '创建路线'}</button>
              <button type="button" disabled={busy} onClick={() => setShowCreate(false)}>取消</button>
            </div>
          </form>}
          {error && <p className="domain-error" role="alert">{error}</p>}
        </div> : <p className="version-empty">这条路线还没有归档版本。</p>}
      </div>
    </section>
  </div>;
}
