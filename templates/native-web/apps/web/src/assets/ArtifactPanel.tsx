import { useCallback, useEffect, useState } from 'react';
import { downloadUrl, listStageArtifacts, type WorkflowAsset } from './api';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function ArtifactPanel({ routeId, stageKey, revision = 0 }: {
  routeId: string;
  stageKey: string;
  revision?: number;
}) {
  const [artifacts, setArtifacts] = useState<WorkflowAsset[]>([]);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try {
      setArtifacts(await listStageArtifacts(routeId, stageKey));
      setError('');
    } catch {
      setError('成果暂时无法载入。');
    }
  }, [routeId, stageKey]);

  useEffect(() => { void reload(); }, [reload, revision]);

  return <section className="artifact-panel" aria-labelledby="artifact-heading">
    <div className="asset-heading">
      <div><p className="card-kicker">路线成果</p><h3 id="artifact-heading">成果</h3></div>
      <button type="button" onClick={reload}>刷新</button>
    </div>
    <div className="asset-list">
      {artifacts.map((artifact) => <a
        key={artifact.id}
        href={downloadUrl(artifact)}
        className="asset-row"
      >
        <span><strong>{artifact.filename}</strong><small>阶段成果</small></span>
        <span>{formatSize(artifact.byteSize)}</span>
      </a>)}
      {artifacts.length === 0 && <p>还没有正式成果。</p>}
    </div>
    {error && <p className="command-error" role="alert">{error}</p>}
  </section>;
}
