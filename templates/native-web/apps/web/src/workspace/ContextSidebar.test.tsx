import { StrictMode } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkflowContext } from '../domain/api';
import * as domainApi from '../domain/api';
import { ContextSidebar } from './ContextSidebar';

vi.mock('../domain/api', async () => {
  const actual = await vi.importActual<typeof import('../domain/api')>('../domain/api');
  return { ...actual, listContexts: vi.fn(), createContext: vi.fn() };
});

afterEach(() => {
  vi.mocked(domainApi.listContexts).mockReset();
  vi.mocked(domainApi.createContext).mockReset();
});

const contexts: WorkflowContext[] = [
  {
    id: 'context-a', title: '产品发布', status: 'active',
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
  },
  {
    id: 'context-b', title: '客户研究', status: 'active',
    createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  },
];

it('switches Contexts and keeps manual creation and import secondary', async () => {
  const onSelectContext = vi.fn();
  const onCreateContext = vi.fn().mockResolvedValue(undefined);
  const onImport = vi.fn();
  render(<ContextSidebar
    contexts={contexts}
    selectedContextId="context-a"
    onSelectContext={onSelectContext}
    onCreateContext={onCreateContext}
    onRenameContext={vi.fn()}
    onImport={onImport}
  />);

  await userEvent.click(screen.getByRole('button', { name: /客户研究 打开/ }));
  expect(onSelectContext).toHaveBeenCalledWith('context-b');
  expect(screen.queryByLabelText('Context 名称')).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: '更多 Context 操作' }));
  await userEvent.click(screen.getByRole('button', { name: '新建 Context' }));
  await userEvent.type(screen.getByLabelText('Context 名称'), '手动规划');
  await userEvent.keyboard('{Enter}');
  expect(onCreateContext).toHaveBeenCalledWith('手动规划');

  await userEvent.click(screen.getByRole('button', { name: '更多 Context 操作' }));
  await userEvent.click(screen.getByRole('button', { name: '导入 Context' }));
  expect(onImport).toHaveBeenCalledOnce();
});

it('saves rename with Enter, cancels with Escape, and restores trigger focus', async () => {
  const onRenameContext = vi.fn().mockResolvedValue(undefined);
  render(<ContextSidebar
    contexts={contexts}
    selectedContextId="context-a"
    onSelectContext={vi.fn()}
    onRenameContext={onRenameContext}
  />);

  await userEvent.click(screen.getByRole('button', { name: '重命名 产品发布' }));
  const input = screen.getByRole('textbox', { name: '重命名 Context' });
  await userEvent.clear(input);
  await userEvent.type(input, '发布总控{Enter}');
  expect(onRenameContext).toHaveBeenCalledWith('context-a', '发布总控');
  expect(screen.getByRole('button', { name: '重命名 产品发布' })).toHaveFocus();

  await userEvent.click(screen.getByRole('button', { name: '重命名 产品发布' }));
  await userEvent.clear(screen.getByRole('textbox', { name: '重命名 Context' }));
  await userEvent.type(screen.getByRole('textbox', { name: '重命名 Context' }), '不要保存{Escape}');
  expect(onRenameContext).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '重命名 产品发布' })).toHaveFocus();
});

it('clears a stale Context list error when the next owner-scoped fetch succeeds', async () => {
  vi.mocked(domainApi.listContexts)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ contexts: [contexts[1]!] });
  const { rerender } = render(<ContextSidebar
    selectedContextId="context-a"
    onSelectContext={vi.fn()}
  />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Context 列表暂时无法载入。');
  rerender(<ContextSidebar
    selectedContextId="context-b"
    onSelectContext={vi.fn()}
  />);

  expect(await screen.findByText('客户研究')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not navigate or settle local state when an uncontrolled create finishes after unmount', async () => {
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  vi.mocked(domainApi.listContexts).mockResolvedValue({ contexts });
  vi.mocked(domainApi.createContext).mockImplementation(async () => {
    await createGate;
    return {
      context: { ...contexts[0]!, id: 'context-created', title: 'Deferred Create' },
      route: {
        id: 'route-created', contextId: 'context-created', name: '主路线',
        originCheckpointId: null, headCheckpointId: 'checkpoint-created',
        createdAt: contexts[0]!.createdAt, updatedAt: contexts[0]!.updatedAt,
      },
      checkpoint: {
        id: 'checkpoint-created', contextId: 'context-created', routeId: 'route-created',
        parentCheckpointId: null, version: 1, stageKey: null, reason: 'bootstrap',
        snapshot: { workflowState: {}, memoryReferences: [], artifacts: [] },
        createdAt: contexts[0]!.createdAt,
      },
    };
  });
  const onSelectContext = vi.fn();
  const view = render(<ContextSidebar onSelectContext={onSelectContext} />);
  await screen.findByText('产品发布');
  await userEvent.click(screen.getByRole('button', { name: '更多 Context 操作' }));
  await userEvent.click(screen.getByRole('button', { name: '新建 Context' }));
  await userEvent.type(screen.getByLabelText('Context 名称'), 'Deferred Create');
  await userEvent.click(screen.getByRole('button', { name: '创建' }));
  view.unmount();

  await act(async () => releaseCreate());

  expect(onSelectContext).not.toHaveBeenCalled();
});

it('completes an uncontrolled create and clears busy state in StrictMode', async () => {
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  vi.mocked(domainApi.listContexts).mockResolvedValue({ contexts });
  vi.mocked(domainApi.createContext).mockImplementation(async () => {
    await createGate;
    return {
      context: { ...contexts[0]!, id: 'context-created', title: 'Strict Create' },
      route: {
        id: 'route-created', contextId: 'context-created', name: '主路线',
        originCheckpointId: null, headCheckpointId: 'checkpoint-created',
        createdAt: contexts[0]!.createdAt, updatedAt: contexts[0]!.updatedAt,
      },
      checkpoint: {
        id: 'checkpoint-created', contextId: 'context-created', routeId: 'route-created',
        parentCheckpointId: null, version: 1, stageKey: null, reason: 'bootstrap',
        snapshot: { workflowState: {}, memoryReferences: [], artifacts: [] },
        createdAt: contexts[0]!.createdAt,
      },
    };
  });
  const onSelectContext = vi.fn();
  render(<StrictMode><ContextSidebar onSelectContext={onSelectContext} /></StrictMode>);
  await screen.findByText('产品发布');
  await userEvent.click(screen.getByRole('button', { name: '更多 Context 操作' }));
  await userEvent.click(screen.getByRole('button', { name: '新建 Context' }));
  await userEvent.type(screen.getByLabelText('Context 名称'), 'Strict Create');
  await userEvent.click(screen.getByRole('button', { name: '创建' }));
  expect(screen.getByRole('button', { name: '创建' })).toBeDisabled();

  await act(async () => releaseCreate());

  expect(onSelectContext).toHaveBeenCalledWith('context-created');
  expect(screen.queryByLabelText('Context 名称')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '更多 Context 操作' }));
  await userEvent.click(screen.getByRole('button', { name: '新建 Context' }));
  await userEvent.type(screen.getByLabelText('Context 名称'), 'Ready Again');
  expect(screen.getByRole('button', { name: '创建' })).toBeEnabled();
});

it('completes rename and restores focus after clearing busy state in StrictMode', async () => {
  let releaseRename!: () => void;
  const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
  const onRenameContext = vi.fn(async () => renameGate);
  render(<StrictMode><ContextSidebar
    contexts={contexts}
    selectedContextId="context-a"
    onSelectContext={vi.fn()}
    onRenameContext={onRenameContext}
  /></StrictMode>);
  await userEvent.click(screen.getByRole('button', { name: '重命名 产品发布' }));
  await userEvent.clear(screen.getByRole('textbox', { name: '重命名 Context' }));
  await userEvent.type(screen.getByRole('textbox', { name: '重命名 Context' }), 'Strict Rename{Enter}');
  expect(screen.getByRole('textbox', { name: '重命名 Context' })).toBeDisabled();

  await act(async () => releaseRename());

  expect(onRenameContext).toHaveBeenCalledWith('context-a', 'Strict Rename');
  const trigger = screen.getByRole('button', { name: '重命名 产品发布' });
  expect(trigger).toHaveFocus();
  await userEvent.click(trigger);
  expect(screen.getByRole('textbox', { name: '重命名 Context' })).toBeEnabled();
});
