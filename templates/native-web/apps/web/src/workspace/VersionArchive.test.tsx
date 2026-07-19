import { StrictMode, useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowCheckpoint } from '../domain/api';
import { VersionArchive } from './VersionArchive';

const historical: WorkflowCheckpoint = {
  id: 'checkpoint-1',
  contextId: 'context-1',
  routeId: 'route-1',
  parentCheckpointId: 'checkpoint-bootstrap',
  version: 1,
  stageKey: null,
  reason: 'workflow_action',
  snapshot: {
    workflowRevision: 'workflow-revision-17',
    sourceCommandId: '80000000-0000-4000-8000-000000000001',
    workflowState: {
      exactMarker: 'immutable-history-state',
    },
    stageProjection: {
      revision: 'projection-revision-9',
      items: [
        {
          key: 'research',
          label: '研究证据',
          status: 'completed',
          checkpointId: 'checkpoint-1',
          summary: '完成历史研究',
        },
        { key: 'decide', label: '形成决策', status: 'waiting_for_review' },
      ],
    },
    memoryReferences: [
      { memoryId: 'memory-user-1', version: 3 },
      { memoryId: 'memory-context-1', version: 7 },
    ],
    artifacts: [{
      id: 'artifact/history 1',
      stage_key: null,
      filename: '研究结论.pdf',
      media_type: 'application/pdf',
      byte_size: 2048,
      sha256: 'a'.repeat(64),
      created_at: '2026-07-17T00:30:00.000Z',
    }],
  },
  createdAt: '2026-07-17T01:00:00.000Z',
};

const head: WorkflowCheckpoint = {
  ...historical,
  id: 'checkpoint-2',
  parentCheckpointId: historical.id,
  version: 2,
  snapshot: {
    workflowState: { exactMarker: 'current-head-state' },
    stageProjection: {
      revision: 'projection-revision-10',
      items: [{
        key: 'history-link',
        label: '查看研究版本',
        status: 'completed',
        checkpointId: historical.id,
      }],
    },
    memoryReferences: [],
    artifacts: [],
  },
  createdAt: '2026-07-18T01:00:00.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VersionArchive read-only Checkpoint browser', () => {
  it('focuses its close control, closes with Escape, and restores its trigger', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>打开测试版本归档</button>
        {open && <VersionArchive
          checkpoints={[historical]}
          routeName="方案路线"
          headCheckpointId={historical.id}
          onClose={() => setOpen(false)}
          onSelectCheckpoint={vi.fn()}
        />}
      </>;
    }
    render(<StrictMode><Harness /></StrictMode>);
    const trigger = screen.getByRole('button', { name: '打开测试版本归档' });

    await user.click(trigger);
    expect(screen.getByRole('button', { name: '关闭版本归档' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '版本归档' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '关闭版本归档' }));
    expect(trigger).toHaveFocus();
  });

  it('does not restore the archive trigger when an external navigation unmounts the dialog', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>打开外部卸载测试</button>
        <button type="button" onClick={() => setOpen(false)}>模拟外部导航</button>
        {open && <VersionArchive
          checkpoints={[historical]}
          routeName="方案路线"
          headCheckpointId={historical.id}
          onClose={() => setOpen(false)}
          onSelectCheckpoint={vi.fn()}
        />}
      </>;
    }
    render(<StrictMode><Harness /></StrictMode>);
    await user.click(screen.getByRole('button', { name: '打开外部卸载测试' }));
    const navigation = screen.getByRole('button', { name: '模拟外部导航' });
    await user.click(navigation);

    expect(screen.queryByRole('dialog', { name: '版本归档' })).not.toBeInTheDocument();
    expect(navigation).toHaveFocus();
  });

  it('renders the exact selected snapshot without any Route or Conversation mutation form', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<VersionArchive
      checkpoints={[head, historical]}
      routeName="方案路线"
      headCheckpointId={head.id}
      initialCheckpointId={historical.id}
      onClose={vi.fn()}
      onSelectCheckpoint={vi.fn()}
    />);

    const dialog = screen.getByRole('dialog', { name: '版本归档' });
    expect(within(dialog).getByText(/immutable-history-state/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/current-head-state/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Stage Projection' })).toBeInTheDocument();
    expect(within(dialog).getByText('waiting_for_review')).toHaveAttribute('data-status', 'neutral');
    expect(within(dialog).getByText('workflow-revision-17')).toBeInTheDocument();
    expect(within(dialog).getByText('projection-revision-9')).toBeInTheDocument();
    expect(within(dialog).getByText('80000000-0000-4000-8000-000000000001')).toBeInTheDocument();
    expect(within(dialog).getByText('checkpoint-bootstrap')).toBeInTheDocument();
    expect(within(dialog).getByText('memory-user-1')).toBeInTheDocument();
    expect(within(dialog).getByText('版本 3')).toBeInTheDocument();
    expect(within(dialog).getByText('memory-context-1')).toBeInTheDocument();
    expect(within(dialog).getByText('版本 7')).toBeInTheDocument();
    const download = within(dialog).getByRole('link', { name: /下载研究结论\.pdf/ });
    expect(download).toHaveAttribute('href', '/api/assets/artifact/artifact%2Fhistory%201/download');
    expect(download).toHaveClass('download-target');
    expect(within(dialog).getByText('2 KB')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: '复制研究结论.pdf链接' }));
    expect(writeText).toHaveBeenCalledWith('/api/assets/artifact/artifact%2Fhistory%201/download');
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /创建路线|新建路线|创建 Conversation/ }))
      .not.toBeInTheDocument();
  });

  it('keeps Stage checkpoint navigation local until historical Input is explicitly selected', async () => {
    const onSelectCheckpoint = vi.fn();
    const onClose = vi.fn();
    render(<VersionArchive
      checkpoints={[head, historical]}
      routeName="方案路线"
      headCheckpointId={head.id}
      initialCheckpointId={head.id}
      onClose={onClose}
      onSelectCheckpoint={onSelectCheckpoint}
    />);

    await userEvent.click(screen.getByRole('button', { name: /查看研究版本.*打开 Checkpoint checkpoint-1/ }));
    expect(screen.getByText(/immutable-history-state/)).toBeInTheDocument();
    expect(onSelectCheckpoint).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '在此版本继续' }));
    expect(onSelectCheckpoint).toHaveBeenCalledTimes(1);
    expect(onSelectCheckpoint).toHaveBeenCalledWith(historical.id);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not present a Projection revision as a missing canonical Workflow revision', () => {
    const projectionOnly: WorkflowCheckpoint = {
      ...historical,
      snapshot: {
        workflowState: historical.snapshot.workflowState,
        stageProjection: {
          ...historical.snapshot.stageProjection!,
          revision: 'projection-only-v9',
        },
        memoryReferences: historical.snapshot.memoryReferences,
        artifacts: historical.snapshot.artifacts,
      },
    };
    render(<VersionArchive
      checkpoints={[projectionOnly]}
      routeName="方案路线"
      headCheckpointId={head.id}
      initialCheckpointId={projectionOnly.id}
      onClose={vi.fn()}
      onSelectCheckpoint={vi.fn()}
    />);

    const workflowSection = screen.getByRole('heading', { name: 'Workflow 状态' }).closest('section')!;
    expect(within(workflowSection).getByText('未记录')).toBeInTheDocument();
    expect(screen.getByText('projection-only-v9')).toBeInTheDocument();
  });

  it('keeps copy retry available with an adjacent alert when the Clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    render(<VersionArchive
      checkpoints={[historical]}
      routeName="方案路线"
      headCheckpointId={head.id}
      initialCheckpointId={historical.id}
      onClose={vi.fn()}
      onSelectCheckpoint={vi.fn()}
    />);

    const copy = screen.getByRole('button', { name: '复制研究结论.pdf链接' });
    const artifact = copy.closest('article')!;
    await userEvent.click(copy);

    expect(within(artifact).getByRole('alert')).toHaveTextContent('链接复制失败，请重试。');
    expect(copy).toHaveTextContent('复制链接');
    expect(copy).toBeEnabled();
  });

  it('catches a rejected copy and clears its alert after a successful retry', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('clipboard denied'))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<VersionArchive
      checkpoints={[historical]}
      routeName="方案路线"
      headCheckpointId={head.id}
      initialCheckpointId={historical.id}
      onClose={vi.fn()}
      onSelectCheckpoint={vi.fn()}
    />);

    const copy = screen.getByRole('button', { name: '复制研究结论.pdf链接' });
    const artifact = copy.closest('article')!;
    await userEvent.click(copy);
    expect(await within(artifact).findByRole('alert')).toHaveTextContent('链接复制失败，请重试。');

    await userEvent.click(copy);
    await waitFor(() => expect(within(artifact).queryByRole('alert')).not.toBeInTheDocument());
    expect(copy).toHaveTextContent('已复制');
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('returns to the current head without exposing a branch naming step', async () => {
    const onSelectCheckpoint = vi.fn();
    const onClose = vi.fn();
    render(<VersionArchive
      checkpoints={[historical, head]}
      routeName="方案路线"
      headCheckpointId={head.id}
      onClose={onClose}
      onSelectCheckpoint={onSelectCheckpoint}
    />);

    expect(screen.queryByLabelText(/路线名称|Conversation 名称/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '返回当前版本' }));
    expect(onSelectCheckpoint).toHaveBeenCalledWith(head.id);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
