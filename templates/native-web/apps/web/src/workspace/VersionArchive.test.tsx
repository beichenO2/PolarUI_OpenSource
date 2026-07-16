import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { WorkflowCheckpoint } from '../domain/api';
import { VersionArchive } from './VersionArchive';

const checkpoints: WorkflowCheckpoint[] = [
  {
    id: 'checkpoint-2', contextId: 'context-1', routeId: 'route-1', parentCheckpointId: 'checkpoint-1',
    version: 2, stageKey: 'decide', reason: 'workflow_action',
    snapshot: { stages: [
      { stage_key: 'discover', status: 'completed', internal_state: 'done' },
      { stage_key: 'decide', status: 'active', internal_state: 'review' },
    ], artifacts: [{
      id: 'artifact-1', stage_key: 'discover', filename: '研究结论.pdf', media_type: 'application/pdf',
      byte_size: 2048, sha256: 'a'.repeat(64), created_at: '2026-07-17T00:30:00.000Z',
    }] },
    createdAt: '2026-07-17T01:00:00.000Z',
  },
  {
    id: 'checkpoint-1', contextId: 'context-1', routeId: 'route-1', parentCheckpointId: null,
    version: 1, stageKey: 'discover', reason: 'bootstrap',
    snapshot: { stages: [{ stage_key: 'discover', status: 'active', internal_state: 'start' }] },
    createdAt: '2026-07-16T01:00:00.000Z',
  },
];

it('keeps archived versions read only and creates a route only through an explicit action', async () => {
  const onCreateRoute = vi.fn().mockResolvedValue(undefined);
  render(<VersionArchive
    checkpoints={checkpoints}
    routeName="方案路线"
    stageLabels={{ discover: '发现', decide: '决策' }}
    onClose={() => undefined}
    onCreateRoute={onCreateRoute}
  />);

  expect(screen.getByRole('dialog', { name: '版本归档' })).toBeInTheDocument();
  expect(screen.queryByLabelText('消息内容')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '推进阶段' })).not.toBeInTheDocument();
  expect(screen.getByText('阶段更新')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /研究结论\.pdf/ })).toHaveAttribute(
    'href',
    '/api/assets/artifact/artifact-1/download',
  );

  await userEvent.click(screen.getByRole('button', { name: '基于此版本新建路线' }));
  await userEvent.clear(screen.getByLabelText('新路线名称'));
  await userEvent.type(screen.getByLabelText('新路线名称'), '精简方案');
  await userEvent.click(screen.getByRole('button', { name: '创建路线' }));

  expect(onCreateRoute).toHaveBeenCalledWith(checkpoints[0]!.id, '精简方案');
});

it('switches archived versions without exposing workspace controls', async () => {
  render(<VersionArchive
    checkpoints={checkpoints}
    routeName="方案路线"
    stageLabels={{ discover: '发现', decide: '决策' }}
    onClose={() => undefined}
    onCreateRoute={vi.fn()}
  />);

  await userEvent.click(screen.getByRole('button', { name: /版本 01/ }));
  expect(screen.getByText('建立路线')).toBeInTheDocument();
  expect(screen.getAllByText('发现')).toHaveLength(2);
  expect(screen.queryByText('阶段讨论')).not.toBeInTheDocument();
});
