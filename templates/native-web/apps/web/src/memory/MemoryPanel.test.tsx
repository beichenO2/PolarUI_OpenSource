import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoricalMemoryPanel, MemoryPanel } from './MemoryPanel';
import { MemoryApiError, type MemoryItem } from './api';
import * as memoryApi from './api';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    listMemories: vi.fn(),
    listMemoryVersions: vi.fn(),
    reviseMemory: vi.fn(),
    invalidateMemory: vi.fn(),
  };
});

const item: MemoryItem = {
  id: 'memory-1', scope: 'context', contextId: 'context-a', key: 'launch-goal',
  value: { outcome: 'ship', quality: true }, status: 'active', version: 3,
  source: { kind: 'workflow', commandId: 'command-1', conversationId: 'conversation-1' },
  evidence: [{ kind: 'message', id: 'message-1', excerpt: 'ship with quality' }],
  impactScope: { contextIds: ['context-a', 'context-b'] },
  createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
};
const oldVersion: MemoryItem = {
  ...item,
  version: 2,
  value: { outcome: 'draft' },
  status: 'invalidated',
  source: { kind: 'user', conversationId: 'conversation-old' },
  evidence: [{ kind: 'artifact', id: 'artifact-old', excerpt: 'old draft' }],
  impactScope: { contextIds: 'all' },
  createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(memoryApi.listMemories).mockReset().mockResolvedValue([item]);
  vi.mocked(memoryApi.listMemoryVersions).mockReset().mockResolvedValue([item, oldVersion]);
  vi.mocked(memoryApi.reviseMemory).mockReset().mockResolvedValue({ ...item, version: 4 });
  vi.mocked(memoryApi.invalidateMemory).mockReset().mockResolvedValue({
    ...item, status: 'invalidated', version: 4,
  });
});

afterEach(() => vi.restoreAllMocks());

describe('MemoryPanel', () => {
  it.each([
    { kind: 'revise', open: '修正 launch-goal', dialog: '修正 launch-goal', input: 'JSON 值' },
    { kind: 'invalidate', open: '使 launch-goal 失效', dialog: '使 launch-goal 失效', input: '失效原因' },
  ])('opens the $kind modal at its editor and restores its exact trigger after Escape', async ({
    open, dialog: dialogName, input,
  }) => {
    const user = userEvent.setup();
    render(<StrictMode><MemoryPanel ownerKey="demo:user-1" contextId="context-a" /></StrictMode>);
    const trigger = await screen.findByRole('button', { name: open });

    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: dialogName });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('textbox', { name: input })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: dialogName })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(memoryApi.reviseMemory).not.toHaveBeenCalled();
    expect(memoryApi.invalidateMemory).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'revise', open: '修正 launch-goal', dialog: '修正 launch-goal' },
    { kind: 'invalidate', open: '使 launch-goal 失效', dialog: '使 launch-goal 失效' },
  ])('restores the exact $kind trigger when Cancel closes the modal', async ({
    open, dialog: dialogName,
  }) => {
    const user = userEvent.setup();
    render(<StrictMode><MemoryPanel ownerKey="demo:user-1" contextId="context-a" /></StrictMode>);
    const trigger = await screen.findByRole('button', { name: open });

    await user.click(trigger);
    await user.click(within(screen.getByRole('dialog', { name: dialogName }))
      .getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('dialog', { name: dialogName })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(memoryApi.reviseMemory).not.toHaveBeenCalled();
    expect(memoryApi.invalidateMemory).not.toHaveBeenCalled();
  });

  it('shows both scopes and all public memory metadata', async () => {
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);

    expect(screen.getByRole('tab', { name: '情景记忆' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '用户记忆' })).toBeInTheDocument();
    expect(await screen.findByText('launch-goal')).toBeInTheDocument();
    expect(screen.getByText('只作用于当前 Context，并为后续处理提供持续约束。')).toBeInTheDocument();
    expect(screen.getByText(/"outcome": "ship"/)).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText(/workflow · command-1 · conversation-1/)).toBeInTheDocument();
    expect(screen.getByText('2026-07-17T00:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText('2026-07-18T00:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText('版本 3')).toBeInTheDocument();
    expect(screen.getByText('context-a、context-b')).toBeInTheDocument();
    expect(screen.getByText(/message · message-1 · ship with quality/)).toBeInTheDocument();
  });

  it('loads and renders the complete immutable version history', async () => {
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '查看 launch-goal 的完整版本历史' }));

    const history = await screen.findByRole('region', { name: 'launch-goal 的版本历史' });
    const version3 = within(history).getByRole('article', { name: 'launch-goal 版本 3' });
    expect(within(version3).getByText(/"outcome": "ship"/)).toBeInTheDocument();
    expect(within(version3).getByText('active')).toBeInTheDocument();
    expect(within(version3).getByText(/workflow · command-1 · conversation-1/)).toBeInTheDocument();
    expect(within(version3).getByText('2026-07-17T00:00:00.000Z')).toBeInTheDocument();
    expect(within(version3).getByText('2026-07-18T00:00:00.000Z')).toBeInTheDocument();
    expect(within(version3).getByText('版本 3')).toBeInTheDocument();
    expect(within(version3).getByText('context-a、context-b')).toBeInTheDocument();
    expect(within(version3).getByText(/message · message-1 · ship with quality/)).toBeInTheDocument();

    const version2 = within(history).getByRole('article', { name: 'launch-goal 版本 2' });
    expect(within(version2).getByText(/"outcome": "draft"/)).toBeInTheDocument();
    expect(within(version2).getByText('invalidated')).toBeInTheDocument();
    expect(within(version2).getByText(/user · conversation-old/)).toBeInTheDocument();
    expect(within(version2).getAllByText('2026-07-16T00:00:00.000Z')).toHaveLength(2);
    expect(within(version2).getByText('版本 2')).toBeInTheDocument();
    expect(within(version2).getByText('全部 Context')).toBeInTheDocument();
    expect(within(version2).getByText(/artifact · artifact-old · old draft/)).toBeInTheDocument();
    expect(memoryApi.listMemoryVersions).toHaveBeenCalledWith('memory-1', expect.any(AbortSignal));
  });

  it.each([
    { kind: 'revise' as const, open: '修正 launch-goal', submit: '保存修正' },
    { kind: 'invalidate' as const, open: '使 launch-goal 失效', submit: '确认失效' },
  ])('does not let a deferred old history overwrite a successful $kind', async ({ kind, open, submit }) => {
    let resolveHistory!: (items: MemoryItem[]) => void;
    const deferredHistory = new Promise<MemoryItem[]>((resolve) => { resolveHistory = resolve; });
    const updated = {
      ...item,
      version: 4,
      ...(kind === 'invalidate' ? { status: 'invalidated' as const } : { value: { outcome: 'approved' } }),
    };
    vi.mocked(memoryApi.listMemoryVersions).mockReturnValueOnce(deferredHistory);
    vi.mocked(memoryApi.listMemories)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([updated]);
    if (kind === 'revise') vi.mocked(memoryApi.reviseMemory).mockResolvedValueOnce(updated);
    else vi.mocked(memoryApi.invalidateMemory).mockResolvedValueOnce(updated);
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '查看 launch-goal 的完整版本历史' }));
    await waitFor(() => expect(memoryApi.listMemoryVersions).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: open }));
    const dialog = screen.getByRole('dialog', { name: open });
    if (kind === 'invalidate') {
      await userEvent.type(within(dialog).getByRole('textbox', { name: '失效原因' }), '由新事实替代');
    }
    await userEvent.click(within(dialog).getByRole('button', { name: submit }));
    expect(await screen.findByText('版本 4')).toBeInTheDocument();

    await act(async () => resolveHistory([item, oldVersion]));
    expect(screen.queryByRole('region', { name: 'launch-goal 的版本历史' })).not.toBeInTheDocument();
  });

  it('keeps old history invalid after a 409 whose latest-version refresh fails', async () => {
    vi.mocked(memoryApi.listMemoryVersions).mockResolvedValueOnce([item, oldVersion]);
    vi.mocked(memoryApi.listMemories)
      .mockResolvedValueOnce([item])
      .mockRejectedValueOnce(new MemoryApiError('REQUEST_FAILED', 503));
    vi.mocked(memoryApi.reviseMemory).mockRejectedValueOnce(
      new MemoryApiError('MEMORY_VERSION_CONFLICT', 409),
    );
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '查看 launch-goal 的完整版本历史' }));
    await screen.findByRole('region', { name: 'launch-goal 的版本历史' });
    await userEvent.click(screen.getByRole('button', { name: '修正 launch-goal' }));
    const dialog = screen.getByRole('dialog', { name: '修正 launch-goal' });
    await userEvent.click(within(dialog).getByRole('button', { name: '保存修正' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('最新记忆无法载入');
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('region', { name: 'launch-goal 的版本历史' })).not.toBeInTheDocument();
  });

  it('revises a memory directly with its expectedVersion and never emits a Workflow Command', async () => {
    const revised = { ...item, version: 4, value: { outcome: 'approved' } };
    vi.mocked(memoryApi.listMemories)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([revised]);
    vi.mocked(memoryApi.reviseMemory).mockResolvedValueOnce(revised);
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '查看 launch-goal 的完整版本历史' }));
    await screen.findByRole('region', { name: 'launch-goal 的版本历史' });
    await userEvent.click(screen.getByRole('button', { name: '修正 launch-goal' }));
    const dialog = screen.getByRole('dialog', { name: '修正 launch-goal' });
    const value = within(dialog).getByRole('textbox', { name: 'JSON 值' });
    fireEvent.change(value, { target: { value: '{"outcome":"approved"}' } });
    await userEvent.click(within(dialog).getByRole('button', { name: '保存修正' }));

    await waitFor(() => expect(memoryApi.reviseMemory).toHaveBeenCalledWith(
      'memory-1',
      { value: { outcome: 'approved' }, expectedVersion: 3 },
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText('版本 4')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'launch-goal 的版本历史' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Workflow Command/)).not.toBeInTheDocument();
  });

  it('restores the revise trigger after a successful mutation and exact refresh', async () => {
    const revised = { ...item, version: 4, value: { outcome: 'approved' } };
    vi.mocked(memoryApi.listMemories)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([revised]);
    vi.mocked(memoryApi.reviseMemory).mockResolvedValueOnce(revised);
    const user = userEvent.setup();
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    const trigger = await screen.findByRole('button', { name: '修正 launch-goal' });

    await user.click(trigger);
    await user.click(within(screen.getByRole('dialog', { name: '修正 launch-goal' }))
      .getByRole('button', { name: '保存修正' }));

    expect(await screen.findByText('版本 4')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '修正 launch-goal' })).toHaveFocus());
  });

  it('hard-locks a mutation against same-tick duplicate submit and cancellation until exact refresh', async () => {
    let resolveRevision!: (value: MemoryItem) => void;
    const revision = new Promise<MemoryItem>((resolve) => { resolveRevision = resolve; });
    const revised = { ...item, version: 4, value: { outcome: 'approved' } };
    vi.mocked(memoryApi.listMemories)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([revised]);
    vi.mocked(memoryApi.reviseMemory).mockReturnValueOnce(revision);
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '修正 launch-goal' }));
    const dialog = screen.getByRole('dialog', { name: '修正 launch-goal' });
    const submit = within(dialog).getByRole('button', { name: '保存修正' });
    const cancel = within(dialog).getByRole('button', { name: '取消' });
    const value = within(dialog).getByRole('textbox', { name: 'JSON 值' });
    const originalValue = value.getAttribute('value') ?? (value as HTMLTextAreaElement).value;

    await act(async () => {
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      fireEvent.keyDown(dialog, { key: 'Escape' });
      fireEvent.change(value, { target: { value: '{"outcome":"same-tick-overwrite"}' } });
    });
    expect(memoryApi.reviseMemory).toHaveBeenCalledTimes(1);
    expect(memoryApi.reviseMemory).toHaveBeenCalledWith(
      'memory-1',
      expect.objectContaining({ expectedVersion: 3 }),
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('dialog', { name: '修正 launch-goal' })).toBeInTheDocument();
    expect(value).toHaveValue(originalValue);
    expect(submit).toBeDisabled();
    expect(value).toBeDisabled();
    expect(cancel).toBeDisabled();

    await act(async () => resolveRevision(revised));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '修正 launch-goal' }))
      .not.toBeInTheDocument());
    expect(await screen.findByText('版本 4')).toBeInTheDocument();
    expect(memoryApi.listMemories).toHaveBeenCalledTimes(2);
  });

  it('does not let an old scope action completion unlock or close a newer scope action', async () => {
    const itemB = {
      ...item, id: 'memory-b', contextId: 'context-b', key: 'beta-goal', version: 7,
      value: { outcome: 'beta' },
    };
    const revisedB = { ...itemB, version: 8, value: { outcome: 'beta-approved' } };
    let resolveA!: (value: MemoryItem) => void;
    let resolveB!: (value: MemoryItem) => void;
    const actionA = new Promise<MemoryItem>((resolve) => { resolveA = resolve; });
    const actionB = new Promise<MemoryItem>((resolve) => { resolveB = resolve; });
    vi.mocked(memoryApi.listMemories).mockImplementation((input) =>
      input.scope === 'context' && input.contextId === 'context-a'
        ? Promise.resolve([item])
        : Promise.resolve([revisedB]));
    vi.mocked(memoryApi.reviseMemory)
      .mockReturnValueOnce(actionA)
      .mockReturnValueOnce(actionB);
    const rendered = render(<MemoryPanel
      ownerKey="demo:user-1"
      scope="context"
      contextId="context-a"
      hideScopeTabs
    />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '修正 launch-goal' }));
    await userEvent.click(screen.getByRole('button', { name: '保存修正' }));
    await waitFor(() => expect(memoryApi.reviseMemory).toHaveBeenCalledTimes(1));

    rendered.rerender(<MemoryPanel
      ownerKey="demo:user-1"
      scope="context"
      contextId="context-b"
      hideScopeTabs
    />);
    await screen.findByText('beta-goal');
    await userEvent.click(screen.getByRole('button', { name: '修正 beta-goal' }));
    const dialogB = screen.getByRole('dialog', { name: '修正 beta-goal' });
    const saveB = within(dialogB).getByRole('button', { name: '保存修正' });
    await userEvent.click(saveB);
    await waitFor(() => expect(memoryApi.reviseMemory).toHaveBeenCalledTimes(2));
    expect(saveB).toBeDisabled();

    await act(async () => resolveA({ ...item, version: 4 }));
    expect(screen.getByRole('dialog', { name: '修正 beta-goal' })).toBeInTheDocument();
    expect(saveB).toBeDisabled();

    await act(async () => resolveB(revisedB));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '修正 beta-goal' }))
      .not.toBeInTheDocument());
    expect(await screen.findByText('版本 8')).toBeInTheDocument();
  });

  it('invalidates through an auditable dialog with expectedVersion', async () => {
    const invalidated = { ...item, status: 'invalidated' as const, version: 4 };
    vi.mocked(memoryApi.listMemories)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([invalidated]);
    vi.mocked(memoryApi.invalidateMemory).mockResolvedValueOnce(invalidated);
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '查看 launch-goal 的完整版本历史' }));
    await screen.findByRole('region', { name: 'launch-goal 的版本历史' });
    await userEvent.click(screen.getByRole('button', { name: '使 launch-goal 失效' }));
    const dialog = screen.getByRole('dialog', { name: '使 launch-goal 失效' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: '失效原因' }), '已由新决定取代');
    await userEvent.click(within(dialog).getByRole('button', { name: '确认失效' }));

    await waitFor(() => expect(memoryApi.invalidateMemory).toHaveBeenCalledWith(
      'memory-1',
      { expectedVersion: 3, reason: '已由新决定取代' },
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText('版本 4')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'launch-goal 的版本历史' })).not.toBeInTheDocument();
  });

  it('focuses the same-memory revise action when successful invalidation removes its trigger', async () => {
    const invalidated = { ...item, status: 'invalidated' as const, version: 4 };
    vi.mocked(memoryApi.listMemories)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([invalidated]);
    vi.mocked(memoryApi.invalidateMemory).mockResolvedValueOnce(invalidated);
    const user = userEvent.setup();
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    const trigger = await screen.findByRole('button', { name: '使 launch-goal 失效' });

    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '使 launch-goal 失效' });
    await user.type(within(dialog).getByRole('textbox', { name: '失效原因' }), '由新事实替代');
    await user.click(within(dialog).getByRole('button', { name: '确认失效' }));

    expect(await screen.findByText('版本 4')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '使 launch-goal 失效' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '修正 launch-goal' })).toHaveFocus());
  });

  it('preserves a proposed revision through 409 refresh and retries against the latest version', async () => {
    const remote = { ...item, version: 4, value: { outcome: 'remote' } };
    vi.mocked(memoryApi.listMemories)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([remote]);
    vi.mocked(memoryApi.reviseMemory)
      .mockRejectedValueOnce(new MemoryApiError('MEMORY_VERSION_CONFLICT', 409))
      .mockResolvedValueOnce({ ...remote, version: 5, value: { outcome: 'proposed' } });
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '查看 launch-goal 的完整版本历史' }));
    await screen.findByRole('region', { name: 'launch-goal 的版本历史' });
    await userEvent.click(screen.getByRole('button', { name: '修正 launch-goal' }));
    const dialog = screen.getByRole('dialog', { name: '修正 launch-goal' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'JSON 值' }), {
      target: { value: '{"outcome":"proposed"}' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: '保存修正' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('版本冲突：已载入服务器最新版本，请检查后重试。');
    expect(memoryApi.listMemories).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('region', { name: 'launch-goal 的版本历史' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'JSON 值' })).toHaveValue('{"outcome":"proposed"}');
    expect(within(dialog).getByText(/"outcome": "remote"/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '重试修正' }));
    await waitFor(() => expect(memoryApi.reviseMemory).toHaveBeenNthCalledWith(
      2,
      'memory-1',
      { value: { outcome: 'proposed' }, expectedVersion: 4 },
      expect.any(AbortSignal),
    ));
  });

  it('recovers a failed conflict refresh in place without losing the proposal', async () => {
    const remote = { ...item, version: 5, value: { outcome: 'remote-v5' } };
    const revised = { ...remote, version: 6, value: { outcome: 'proposed' } };
    vi.mocked(memoryApi.listMemories)
      .mockResolvedValueOnce([item])
      .mockRejectedValueOnce(new MemoryApiError('REQUEST_FAILED', 503))
      .mockResolvedValueOnce([remote])
      .mockResolvedValueOnce([revised]);
    vi.mocked(memoryApi.reviseMemory)
      .mockRejectedValueOnce(new MemoryApiError('MEMORY_VERSION_CONFLICT', 409))
      .mockResolvedValueOnce(revised);
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '修正 launch-goal' }));
    const dialog = screen.getByRole('dialog', { name: '修正 launch-goal' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'JSON 值' }), {
      target: { value: '{"outcome":"proposed"}' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: '保存修正' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('版本冲突：最新记忆无法载入，请刷新后再试。');
    expect(alert).not.toHaveTextContent('已刷新');
    expect(within(dialog).getByRole('button', { name: '重新载入后重试' })).toBeDisabled();
    expect(within(dialog).getByRole('textbox', { name: 'JSON 值' })).toHaveValue('{"outcome":"proposed"}');
    const reload = within(dialog).getByRole('button', { name: '重新载入最新版本' });
    expect(reload).toBeEnabled();
    expect(memoryApi.reviseMemory).toHaveBeenCalledTimes(1);

    await userEvent.click(reload);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('版本冲突：已载入服务器最新版本，请检查后重试。');
    expect(within(dialog).getByRole('textbox', { name: 'JSON 值' })).toHaveValue('{"outcome":"proposed"}');
    expect(within(dialog).getByText(/"outcome": "remote-v5"/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '重试修正' }));
    await waitFor(() => expect(memoryApi.reviseMemory).toHaveBeenNthCalledWith(
      2,
      'memory-1',
      { value: { outcome: 'proposed' }, expectedVersion: 5 },
      expect.any(AbortSignal),
    ));
  });

  it('preserves invalidate reason through 409 and retries with the refreshed expectedVersion', async () => {
    const remote = { ...item, version: 4, value: { outcome: 'remote' } };
    vi.mocked(memoryApi.listMemories)
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([remote]);
    vi.mocked(memoryApi.invalidateMemory)
      .mockRejectedValueOnce(new MemoryApiError('MEMORY_VERSION_CONFLICT', 409))
      .mockResolvedValueOnce({ ...remote, version: 5, status: 'invalidated' });
    render(<MemoryPanel ownerKey="demo:user-1" contextId="context-a" />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '使 launch-goal 失效' }));
    const dialog = screen.getByRole('dialog', { name: '使 launch-goal 失效' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: '失效原因' }), '由新事实替代');
    await userEvent.click(within(dialog).getByRole('button', { name: '确认失效' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('版本冲突：已载入服务器最新版本，请检查后重试。');
    expect(within(dialog).getByRole('textbox', { name: '失效原因' })).toHaveValue('由新事实替代');
    await userEvent.click(within(dialog).getByRole('button', { name: '重试失效' }));
    await waitFor(() => expect(memoryApi.invalidateMemory).toHaveBeenNthCalledWith(
      2,
      'memory-1',
      { expectedVersion: 4, reason: '由新事实替代' },
      expect.any(AbortSignal),
    ));
  });

  it('does not let an old Context conflict refresh replace a newer Context dialog', async () => {
    const itemB = {
      ...item, id: 'memory-b', contextId: 'context-b', key: 'beta-goal', version: 7,
      value: { outcome: 'beta' },
    };
    let resolveOldRefresh!: (items: MemoryItem[]) => void;
    const oldRefresh = new Promise<MemoryItem[]>((resolve) => { resolveOldRefresh = resolve; });
    let contextACalls = 0;
    vi.mocked(memoryApi.listMemories).mockImplementation((input) => {
      if (input.scope === 'context' && input.contextId === 'context-a') {
        contextACalls += 1;
        return contextACalls === 1 ? Promise.resolve([item]) : oldRefresh;
      }
      return Promise.resolve([itemB]);
    });
    vi.mocked(memoryApi.reviseMemory).mockRejectedValueOnce(
      new MemoryApiError('MEMORY_VERSION_CONFLICT', 409),
    );
    const rendered = render(<MemoryPanel
      ownerKey="demo:user-1"
      scope="context"
      contextId="context-a"
      hideScopeTabs
    />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '修正 launch-goal' }));
    await userEvent.click(screen.getByRole('button', { name: '保存修正' }));
    await waitFor(() => expect(contextACalls).toBe(2));

    rendered.rerender(<MemoryPanel
      ownerKey="demo:user-1"
      scope="context"
      contextId="context-b"
      hideScopeTabs
    />);
    await screen.findByText('beta-goal');
    await userEvent.click(screen.getByRole('button', { name: '修正 beta-goal' }));
    const dialogB = screen.getByRole('dialog', { name: '修正 beta-goal' });
    fireEvent.change(within(dialogB).getByRole('textbox', { name: 'JSON 值' }), {
      target: { value: '{"outcome":"beta-proposed"}' },
    });

    await act(async () => resolveOldRefresh([{ ...item, version: 4, value: { outcome: 'remote-a' } }]));
    expect(screen.getByRole('dialog', { name: '修正 beta-goal' })).toBeInTheDocument();
    expect(within(dialogB).getByRole('textbox', { name: 'JSON 值' })).toHaveValue('{"outcome":"beta-proposed"}');
    expect(within(dialogB).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(dialogB).getByRole('button', { name: '保存修正' })).toBeEnabled();
  });

  it('keeps user memory stable across Context switches in controlled mode', async () => {
    const userItem = { ...item, id: 'user-memory', scope: 'user' as const, contextId: null, key: 'taste' };
    vi.mocked(memoryApi.listMemories).mockResolvedValue([userItem]);
    const rendered = render(<MemoryPanel
      ownerKey="demo:user-1"
      scope="user"
      contextId="context-a"
      hideScopeTabs
    />);
    expect(await screen.findByText('taste')).toBeInTheDocument();

    rendered.rerender(<MemoryPanel
      ownerKey="demo:user-1"
      scope="user"
      contextId="context-b"
      hideScopeTabs
    />);
    expect(screen.getByText('taste')).toBeInTheDocument();
    expect(memoryApi.listMemories).toHaveBeenCalledTimes(1);
    expect(screen.getByText('跨 Context 生效，用于形成长期的用户模型。')).toBeInTheDocument();
  });

  it('isolates Context memory and ignores a stale response after switching Context', async () => {
    let resolveA!: (items: MemoryItem[]) => void;
    const deferredA = new Promise<MemoryItem[]>((resolve) => { resolveA = resolve; });
    vi.mocked(memoryApi.listMemories).mockImplementation((input) => input.scope === 'context' && input.contextId === 'context-a'
      ? deferredA
      : Promise.resolve([{ ...item, id: 'memory-b', contextId: 'context-b', key: 'beta-goal' }]));
    const rendered = render(<MemoryPanel
      ownerKey="demo:user-1"
      scope="context"
      contextId="context-a"
      hideScopeTabs
    />);

    rendered.rerender(<MemoryPanel
      ownerKey="demo:user-1"
      scope="context"
      contextId="context-b"
      hideScopeTabs
    />);
    expect(await screen.findByText('beta-goal')).toBeInTheDocument();
    await act(async () => resolveA([{ ...item, key: 'alpha-private' }]));
    expect(screen.queryByText('alpha-private')).not.toBeInTheDocument();
  });

  it('hides all previous Context memory state in the synchronous commit frame before B resolves', async () => {
    let resolveB!: (items: MemoryItem[]) => void;
    const deferredB = new Promise<MemoryItem[]>((resolve) => { resolveB = resolve; });
    vi.mocked(memoryApi.listMemories).mockImplementation((input) =>
      input.scope === 'context' && input.contextId === 'context-a'
        ? Promise.resolve([item])
        : deferredB);
    vi.mocked(memoryApi.listMemoryVersions).mockResolvedValue([item, oldVersion]);
    const commitFrames: Array<{
      contextId: string;
      hasA: boolean;
      hasDialog: boolean;
      hasHistory: boolean;
      hasAlert: boolean;
    }> = [];
    function CommitProbe({ contextId }: { contextId: string }) {
      useLayoutEffect(() => {
        commitFrames.push({
          contextId,
          hasA: document.body.textContent?.includes('launch-goal') ?? false,
          hasDialog: Boolean(document.querySelector('[role="dialog"]')),
          hasHistory: document.body.textContent?.includes('完整版本历史') ?? false,
          hasAlert: Boolean(document.querySelector('[role="alert"]')),
        });
      }, [contextId]);
      return null;
    }
    function Harness({ contextId }: { contextId: string }) {
      return <>
        <MemoryPanel ownerKey="demo:user-1" scope="context" contextId={contextId} hideScopeTabs />
        <CommitProbe contextId={contextId} />
      </>;
    }
    const rendered = render(<Harness contextId="context-a" />);
    await screen.findByText('launch-goal');
    await userEvent.click(screen.getByRole('button', { name: '查看 launch-goal 的完整版本历史' }));
    await screen.findByRole('region', { name: 'launch-goal 的版本历史' });
    await userEvent.click(screen.getByRole('button', { name: '修正 launch-goal' }));
    const dialog = screen.getByRole('dialog', { name: '修正 launch-goal' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'JSON 值' }), {
      target: { value: '{' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: '保存修正' }));
    await within(dialog).findByRole('alert');

    rendered.rerender(<Harness contextId="context-b" />);

    expect(commitFrames.at(-1)).toEqual({
      contextId: 'context-b',
      hasA: false,
      hasDialog: false,
      hasHistory: false,
      hasAlert: false,
    });
    expect(screen.queryByText('launch-goal')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => resolveB([{ ...item, id: 'memory-b', key: 'beta-goal', contextId: 'context-b' }]));
    expect(await screen.findByText('beta-goal')).toBeInTheDocument();
  });
});

describe('HistoricalMemoryPanel', () => {
  it('loads every reference but renders only the exact Context versions without current-memory actions', async () => {
    const contextV4: MemoryItem = {
      ...item,
      key: 'checkpoint-goal',
      version: 4,
      value: { outcome: 'checkpoint-v4' },
    };
    const contextV9: MemoryItem = {
      ...contextV4,
      version: 9,
      value: { outcome: 'current-v9' },
    };
    const userV2: MemoryItem = {
      ...item,
      id: 'memory-user',
      scope: 'user',
      contextId: null,
      key: 'user-taste',
      version: 2,
      value: { tone: 'direct' },
    };
    vi.mocked(memoryApi.listMemories).mockResolvedValue([contextV9]);
    vi.mocked(memoryApi.listMemoryVersions).mockImplementation((memoryId) => Promise.resolve(
      memoryId === contextV4.id ? [contextV9, contextV4] : [userV2],
    ));

    render(<HistoricalMemoryPanel
      ownerKey="demo:user-1"
      contextId="context-a"
      checkpointId="checkpoint-history"
      memoryReferences={[
        { memoryId: contextV4.id, version: 4 },
        { memoryId: userV2.id, version: 2 },
      ]}
      scope="context"
    />);

    expect(await screen.findByText('checkpoint-goal')).toBeInTheDocument();
    expect(screen.getByText(/"outcome": "checkpoint-v4"/)).toBeInTheDocument();
    expect(screen.getByText('版本 4')).toBeInTheDocument();
    expect(screen.queryByText(/current-v9/)).not.toBeInTheDocument();
    expect(screen.queryByText('user-taste')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /修正|失效|完整版本历史/ })).not.toBeInTheDocument();
    expect(memoryApi.listMemoryVersions).toHaveBeenCalledTimes(2);
    expect(memoryApi.listMemoryVersions).toHaveBeenCalledWith(contextV4.id, expect.any(AbortSignal));
    expect(memoryApi.listMemoryVersions).toHaveBeenCalledWith(userV2.id, expect.any(AbortSignal));
    expect(memoryApi.listMemories).not.toHaveBeenCalled();
    expect(memoryApi.reviseMemory).not.toHaveBeenCalled();
    expect(memoryApi.invalidateMemory).not.toHaveBeenCalled();
  });

  it('aborts an obsolete owner Context and Checkpoint load and ignores its late result', async () => {
    let resolveOld!: (items: MemoryItem[]) => void;
    const oldRequest = new Promise<MemoryItem[]>((resolve) => { resolveOld = resolve; });
    const nextItem: MemoryItem = {
      ...item,
      id: 'memory-next',
      contextId: 'context-b',
      key: 'next-checkpoint-goal',
      version: 7,
    };
    let oldSignal: AbortSignal | undefined;
    vi.mocked(memoryApi.listMemoryVersions).mockImplementation((memoryId, signal) => {
      if (memoryId === item.id) {
        oldSignal = signal;
        return oldRequest;
      }
      return Promise.resolve([nextItem]);
    });
    const rendered = render(<HistoricalMemoryPanel
      ownerKey="demo:user-1"
      contextId="context-a"
      checkpointId="checkpoint-a"
      memoryReferences={[{ memoryId: item.id, version: item.version }]}
      scope="context"
    />);
    await waitFor(() => expect(memoryApi.listMemoryVersions).toHaveBeenCalledTimes(1));

    rendered.rerender(<HistoricalMemoryPanel
      ownerKey="demo:user-2"
      contextId="context-b"
      checkpointId="checkpoint-b"
      memoryReferences={[{ memoryId: nextItem.id, version: nextItem.version }]}
      scope="context"
    />);

    expect(await screen.findByText('next-checkpoint-goal')).toBeInTheDocument();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolveOld([item]));
    expect(screen.queryByText('launch-goal')).not.toBeInTheDocument();
    expect(screen.getByText('next-checkpoint-goal')).toBeInTheDocument();
  });
});
