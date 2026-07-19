import { StrictMode, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ArchivePanel } from './ArchivePanel';

afterEach(() => {
  vi.restoreAllMocks();
});

it('is a modal that focuses close, closes with Escape, and restores its trigger', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ conversations: [] }));
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <>
      <button type="button" onClick={() => setOpen(true)}>打开测试导入档案</button>
      {open && <ArchivePanel onClose={() => setOpen(false)} />}
    </>;
  }
  render(<StrictMode><Harness /></StrictMode>);
  const trigger = screen.getByRole('button', { name: '打开测试导入档案' });

  await user.click(trigger);
  expect(screen.getByRole('dialog', { name: 'LibreChat 历史档案' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'LibreChat 历史档案' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();

  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: '关闭' }));
  expect(trigger).toHaveFocus();
});

it('does not restore the archive trigger when an external navigation unmounts the dialog', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ conversations: [] }));
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <>
      <button type="button" onClick={() => setOpen(true)}>打开外部卸载测试</button>
      <button type="button" onClick={() => setOpen(false)}>模拟外部导航</button>
      {open && <ArchivePanel onClose={() => setOpen(false)} />}
    </>;
  }
  render(<StrictMode><Harness /></StrictMode>);
  await user.click(screen.getByRole('button', { name: '打开外部卸载测试' }));
  const navigation = screen.getByRole('button', { name: '模拟外部导航' });
  await user.click(navigation);

  expect(screen.queryByRole('dialog', { name: 'LibreChat 历史档案' })).not.toBeInTheDocument();
  expect(navigation).toHaveFocus();
});

it('marks ready imported-archive downloads as touch-sized interactive targets', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input) === '/api/archive/conversations') {
      return Response.json({ conversations: [{ id: 'archive-1', title: '历史讨论', messageCount: 1 }] });
    }
    return Response.json({
      conversation: { id: 'archive-1', title: '历史讨论' },
      messages: [],
      attachments: [{ id: 'legacy-file', filename: 'legacy.txt', status: 'ready' }],
    });
  });
  render(<ArchivePanel onClose={vi.fn()} />);

  await userEvent.click(await screen.findByRole('button', { name: /历史讨论/ }));
  const download = await screen.findByRole('link', { name: 'legacy.txt' });
  expect(download).toHaveAttribute('href', '/api/assets/archive/legacy-file/download');
  expect(download).toHaveClass('download-target');
});
