import { useCallback, useEffect, useRef, useState } from 'react';
import type { StageProjectionSnapshot } from '../domain/api';

const knownStatuses = new Map([
  ['not_started', '未开始'],
  ['active', '进行中'],
  ['completed', '已完成'],
]);

type ProjectionItem = StageProjectionSnapshot['items'][number];

function statusLabel(status: string) {
  return knownStatuses.get(status) ?? status;
}

function ProjectionRow({ item, onSelectCheckpoint }: {
  item: ProjectionItem;
  onSelectCheckpoint?: (checkpointId: string) => void;
}) {
  const content = <>
    <span><strong>{item.label}</strong>{item.summary && <small>{item.summary}</small>}</span>
    <span data-status={knownStatuses.has(item.status) ? item.status : 'neutral'}>
      {statusLabel(item.status)}
    </span>
  </>;
  return <li data-testid="stage-projection-item">
    {item.checkpointId && onSelectCheckpoint
      ? <button
        type="button"
        aria-label={`${item.label} · ${statusLabel(item.status)} · 打开 Checkpoint ${item.checkpointId}`}
        onClick={() => onSelectCheckpoint(item.checkpointId!)}
      >{content}</button>
      : <div>{content}</div>}
  </li>;
}

function ProjectionList({ items, onSelectCheckpoint }: {
  items: ProjectionItem[];
  onSelectCheckpoint?: (checkpointId: string) => void;
}) {
  return <ol className="stage-projection-list">
    {items.map((item, index) => <ProjectionRow
      key={`${index}:${item.key}`}
      item={item}
      onSelectCheckpoint={onSelectCheckpoint}
    />)}
  </ol>;
}

export function StageProjectionPanel({ projection, onSelectCheckpoint }: {
  projection?: StageProjectionSnapshot;
  onSelectCheckpoint?: (checkpointId: string) => void;
}) {
  const [openProjectionIdentity, setOpenProjectionIdentity] = useState<string>();
  const projectionTriggerRef = useRef<HTMLButtonElement>(null);
  const projectionCloseRef = useRef<HTMLButtonElement>(null);
  const projectionReturnFocusRef = useRef<HTMLElement | null>(null);
  const items = projection?.items ?? [];
  const projectionIdentity = JSON.stringify([
    projection?.revision ?? '',
    items.map(({ key, label, status, checkpointId, summary }) => (
      [key, label, status, checkpointId ?? '', summary ?? '']
    )),
  ]);
  const drawerOpen = items.length >= 7 && openProjectionIdentity === projectionIdentity;
  const closeProjection = useCallback(() => {
    const returnFocus = projectionReturnFocusRef.current;
    setOpenProjectionIdentity(undefined);
    queueMicrotask(() => returnFocus?.focus());
  }, []);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeProjection();
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [closeProjection, drawerOpen]);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    projectionCloseRef.current?.focus();
    return undefined;
  }, [drawerOpen]);
  if (items.length === 0) return null;

  const density = items.length === 1 ? 'single' : items.length <= 6 ? 'full' : 'summary';
  const completed = items.filter(({ status }) => status === 'completed').length;
  const activeIndex = items.findIndex(({ status }) => status === 'active');
  const current = activeIndex >= 0 ? items[activeIndex] : undefined;
  const next = items.slice(activeIndex >= 0 ? activeIndex + 1 : 0)
    .find(({ status }) => status === 'not_started');

  return <section className="stage-projection" role="region" aria-label="Stage Projection" data-density={density}>
    <header><div><p className="eyebrow">运行投影</p><h3>Stage Projection</h3></div><span>{projection!.revision}</span></header>
    {items.length <= 6
      ? <ProjectionList items={items} onSelectCheckpoint={onSelectCheckpoint} />
      : <div className="stage-projection-summary">
        <strong>已完成 {completed} / {items.length}</strong>
        {current && <p>当前：{current.label}</p>}
        {next && <p>下一项：{next.label}</p>}
        <button
          ref={projectionTriggerRef}
          type="button"
          aria-expanded={drawerOpen}
          onClick={(event) => {
            projectionReturnFocusRef.current = event.currentTarget;
            setOpenProjectionIdentity(projectionIdentity);
          }}
        >
          查看全部 {items.length} 项
        </button>
      </div>}
    {drawerOpen && <div className="modal-backdrop">
      <section
        className="stage-projection-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="完整 Stage Projection"
        data-orientation="vertical"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          closeProjection();
        }}
      >
        <header><h3>完整 Stage Projection</h3><button
          ref={projectionCloseRef}
          type="button"
          aria-label="关闭完整 Stage Projection"
          onClick={closeProjection}
        >关闭</button></header>
        <ProjectionList items={items} onSelectCheckpoint={onSelectCheckpoint} />
      </section>
    </div>}
  </section>;
}
