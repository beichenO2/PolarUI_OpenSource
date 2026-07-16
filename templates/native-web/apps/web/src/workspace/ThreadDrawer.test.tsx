import { useRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { WorkflowThread } from '../domain/api';
import { ThreadDrawer } from './ThreadDrawer';

const threads: WorkflowThread[] = [
  {
    id: 'thread-a', contextId: 'context-a', routeId: 'route-a', stageKey: 'discover',
    title: '方案梳理', status: 'active', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  },
  {
    id: 'thread-b', contextId: 'context-a', routeId: 'route-a', stageKey: 'discover',
    title: '风险复核', status: 'active', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  },
];

it('opens on demand, switches discussions, and restores focus when closed', async () => {
  const onSelectThread = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    return <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>打开讨论，2 个</button>
      {open && <ThreadDrawer
        threads={threads}
        selectedThreadId={threads[0]!.id}
        stageLabel="发现"
        returnFocusRef={triggerRef}
        onClose={() => setOpen(false)}
        onSelectThread={onSelectThread}
        onCreateThread={vi.fn()}
        onRenameThread={vi.fn()}
        onArchiveThread={vi.fn()}
      />}
    </>;
  }

  render(<Harness />);
  expect(screen.queryByRole('dialog', { name: '阶段讨论' })).not.toBeInTheDocument();
  const trigger = screen.getByRole('button', { name: '打开讨论，2 个' });
  await userEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: '阶段讨论' })).toBeInTheDocument();

  await userEvent.click(screen.getByRole('tab', { name: '风险复核' }));
  expect(onSelectThread).toHaveBeenCalledWith(threads[1]!.id);

  await userEvent.click(screen.getByRole('button', { name: '关闭讨论' }));
  expect(screen.queryByRole('dialog', { name: '阶段讨论' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('creates a discussion inside the drawer', async () => {
  const onCreateThread = vi.fn().mockResolvedValue(undefined);
  render(<ThreadDrawer
    threads={[]}
    stageLabel="发现"
    onClose={() => undefined}
    onSelectThread={() => undefined}
    onCreateThread={onCreateThread}
    onRenameThread={vi.fn()}
    onArchiveThread={vi.fn()}
  />);

  await userEvent.click(screen.getByRole('button', { name: '新建讨论' }));
  await userEvent.type(screen.getByLabelText('讨论标题'), '目标边界');
  await userEvent.click(screen.getByRole('button', { name: '创建讨论' }));
  expect(onCreateThread).toHaveBeenCalledWith('目标边界');
});
