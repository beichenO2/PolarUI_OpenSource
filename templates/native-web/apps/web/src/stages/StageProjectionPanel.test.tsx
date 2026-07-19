import { StrictMode, useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { StageProjectionSnapshot } from '../domain/api';
import { StageProjectionPanel } from './StageProjectionPanel';

function projection(count: number): StageProjectionSnapshot {
  return {
    revision: 'workflow-2026-07-19',
    items: Array.from({ length: count }, (_, index) => ({
      key: `step-${index + 1}`,
      label: `动态步骤 ${index + 1}`,
      status: index < 2 ? 'completed' : index === 2 ? 'active' : 'not_started',
      ...(index === 2 ? { checkpointId: 'checkpoint-active' } : {}),
      summary: `摘要 ${index + 1}`,
    })),
  };
}

describe('StageProjectionPanel density', () => {
  it('hides the Stage module completely for zero items', () => {
    const { container } = render(<StageProjectionPanel projection={projection(0)} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/Stage|阶段/)).not.toBeInTheDocument();
  });

  it('renders one dynamic item as one status block', () => {
    render(<StageProjectionPanel projection={projection(1)} />);
    const panel = screen.getByRole('region', { name: 'Stage Projection' });
    expect(panel).toHaveAttribute('data-density', 'single');
    expect(within(panel).getAllByTestId('stage-projection-item')).toHaveLength(1);
    expect(screen.getByText('workflow-2026-07-19')).toBeInTheDocument();
  });

  it('renders every item in a full vertical list for two through six items', () => {
    render(<StageProjectionPanel projection={projection(6)} />);
    const panel = screen.getByRole('region', { name: 'Stage Projection' });
    expect(panel).toHaveAttribute('data-density', 'full');
    expect(within(panel).getAllByTestId('stage-projection-item')).toHaveLength(6);
  });

  it('summarizes seven or more and opens the complete vertical drawer', async () => {
    render(<StageProjectionPanel projection={projection(7)} />);
    expect(screen.getByText('已完成 2 / 7')).toBeInTheDocument();
    expect(screen.getByText('当前：动态步骤 3')).toBeInTheDocument();
    expect(screen.getByText('下一项：动态步骤 4')).toBeInTheDocument();
    expect(screen.queryAllByTestId('stage-projection-item')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: '查看全部 7 项' }));
    const drawer = screen.getByRole('dialog', { name: '完整 Stage Projection' });
    expect(drawer).toHaveAttribute('data-orientation', 'vertical');
    expect(within(drawer).getAllByTestId('stage-projection-item')).toHaveLength(7);
    await userEvent.click(within(drawer).getByRole('button', { name: '关闭完整 Stage Projection' }));
    expect(screen.queryByRole('dialog', { name: '完整 Stage Projection' })).not.toBeInTheDocument();
  });

  it('closes the complete projection with Escape', async () => {
    const user = userEvent.setup();
    render(<StageProjectionPanel projection={projection(7)} />);

    await user.click(screen.getByRole('button', { name: '查看全部 7 项' }));
    expect(screen.getByRole('dialog', { name: '完整 Stage Projection' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '完整 Stage Projection' })).not.toBeInTheDocument();
  });

  it('moves focus into the complete projection and restores its trigger on every close path', async () => {
    const user = userEvent.setup();
    render(<StrictMode><StageProjectionPanel projection={projection(7)} /></StrictMode>);
    const trigger = screen.getByRole('button', { name: '查看全部 7 项' });

    await user.click(trigger);
    expect(screen.getByRole('button', { name: '关闭完整 Stage Projection' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    const close = screen.getByRole('button', { name: '关闭完整 Stage Projection' });
    expect(close).toHaveFocus();
    await user.click(close);
    expect(trigger).toHaveFocus();
  });

  it('does not steal focus when a projection change unmounts the drawer without a dismissal', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState(projection(7));
      return <>
        <button type="button" onClick={() => setValue({ ...projection(7), revision: 'external-update' })}>
          外部更新 Projection
        </button>
        <StageProjectionPanel projection={value} />
      </>;
    }
    render(<StrictMode><Harness /></StrictMode>);

    await user.click(screen.getByRole('button', { name: '查看全部 7 项' }));
    const externalUpdate = screen.getByRole('button', { name: '外部更新 Projection' });
    await user.click(externalUpdate);

    expect(screen.queryByRole('dialog', { name: '完整 Stage Projection' })).not.toBeInTheDocument();
    expect(externalUpdate).toHaveFocus();
  });

  it('closes the drawer synchronously when projection identity or density changes', async () => {
    const initial = projection(7);
    const rendered = render(<StageProjectionPanel projection={initial} />);
    await userEvent.click(screen.getByRole('button', { name: '查看全部 7 项' }));
    expect(screen.getByRole('dialog', { name: '完整 Stage Projection' })).toBeInTheDocument();

    const revised = {
      ...projection(7),
      revision: 'workflow-2026-07-20',
      items: projection(7).items.map((item) => ({ ...item, label: `新版 ${item.label}` })),
    };
    rendered.rerender(<StageProjectionPanel projection={revised} />);
    expect(screen.queryByRole('dialog', { name: '完整 Stage Projection' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '查看全部 7 项' }));
    expect(screen.getByRole('dialog', { name: '完整 Stage Projection' })).toBeInTheDocument();
    rendered.rerender(<StageProjectionPanel projection={projection(6)} />);
    expect(screen.queryByRole('dialog', { name: '完整 Stage Projection' })).not.toBeInTheDocument();
  });

  it('shows no current item and uses the first known not-started item as next when active is absent', () => {
    const value = projection(7);
    value.items[2] = { ...value.items[2]!, status: 'not_started' };
    render(<StageProjectionPanel projection={value} />);

    expect(screen.queryByText(/当前：/)).not.toBeInTheDocument();
    expect(screen.getByText('下一项：动态步骤 3')).toBeInTheDocument();
  });

  it('skips unknown statuses when finding the known next item after active', () => {
    const value = projection(7);
    value.items[3] = { ...value.items[3]!, status: 'waiting_for_external_system' };
    render(<StageProjectionPanel projection={value} />);

    expect(screen.getByText('当前：动态步骤 3')).toBeInTheDocument();
    expect(screen.getByText('下一项：动态步骤 5')).toBeInTheDocument();
    expect(screen.queryByText('下一项：动态步骤 4')).not.toBeInTheDocument();
  });

  it('does not infer current or next from completed and unknown statuses', () => {
    const value = projection(7);
    value.items = value.items.map((item, index) => ({
      ...item,
      status: index < 2 ? 'completed' : 'waiting_for_external_system',
    }));
    render(<StageProjectionPanel projection={value} />);

    expect(screen.queryByText(/当前：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/下一项：/)).not.toBeInTheDocument();
  });

  it('navigates only checkpoint-backed items and treats unknown status neutrally', async () => {
    const onSelectCheckpoint = vi.fn();
    const value = projection(3);
    value.items[0] = { ...value.items[0]!, status: 'waiting_for_external_system' };
    render(<StageProjectionPanel projection={value} onSelectCheckpoint={onSelectCheckpoint} />);

    expect(screen.getByText('waiting_for_external_system')).toHaveAttribute('data-status', 'neutral');
    expect(screen.queryByRole('button', { name: /动态步骤 1/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /动态步骤 3/ }));
    expect(onSelectCheckpoint).toHaveBeenCalledTimes(1);
    expect(onSelectCheckpoint).toHaveBeenCalledWith('checkpoint-active');
  });

  it('renders prototype-named statuses as neutral raw text without invoking inherited values', () => {
    const value = projection(2);
    value.items[0] = { ...value.items[0]!, status: 'toString' };
    value.items[1] = { ...value.items[1]!, status: 'constructor' };

    expect(() => render(<StageProjectionPanel projection={value} />)).not.toThrow();
    expect(screen.getByText('toString')).toHaveAttribute('data-status', 'neutral');
    expect(screen.getByText('constructor')).toHaveAttribute('data-status', 'neutral');
  });

  it('renders duplicate public item keys without React key collisions and keeps callbacks exact', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onSelectCheckpoint = vi.fn();
    const value = projection(2);
    value.items = [
      { ...value.items[0]!, key: 'duplicate', label: '重复步骤甲', checkpointId: 'checkpoint-a' },
      { ...value.items[1]!, key: 'duplicate', label: '重复步骤乙', checkpointId: 'checkpoint-b' },
    ];

    render(<StageProjectionPanel projection={value} onSelectCheckpoint={onSelectCheckpoint} />);
    expect(screen.getAllByTestId('stage-projection-item')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: /重复步骤甲/ }));
    await userEvent.click(screen.getByRole('button', { name: /重复步骤乙/ }));

    expect(onSelectCheckpoint.mock.calls).toEqual([['checkpoint-a'], ['checkpoint-b']]);
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key|unique ["']key["']/i);
  });
});
