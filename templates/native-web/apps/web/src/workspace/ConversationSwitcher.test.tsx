import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { WorkflowConversation } from '../domain/api';
import { ConversationSwitcher } from './ConversationSwitcher';

const conversations: WorkflowConversation[] = [
  {
    id: 'conversation-a', contextId: 'context-a', routeId: 'route-a', title: '证据整理',
    titleSource: 'agent', isPrimary: true, status: 'active',
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-18T08:00:00.000Z',
  },
  {
    id: 'conversation-b', contextId: 'context-a', routeId: 'route-a', title: '风险讨论',
    titleSource: 'user', isPrimary: false, status: 'active',
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T08:00:00.000Z',
  },
];

it('shows activity, Route and status, switches, and starts an untitled virtual Conversation immediately', async () => {
  const onSelectConversation = vi.fn();
  const onNewConversation = vi.fn();
  const { rerender } = render(<ConversationSwitcher
    conversations={conversations}
    selectedConversationId="conversation-a"
    routeName="主路线"
    onSelectConversation={onSelectConversation}
    onNewConversation={onNewConversation}
    onRenameConversation={vi.fn()}
    onArchiveConversation={vi.fn()}
  />);

  expect(screen.getAllByText(/主路线/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/进行中/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole('button', { name: /^风险讨论 主路线/ }));
  expect(onSelectConversation).toHaveBeenCalledWith('conversation-b');

  await userEvent.click(screen.getByRole('button', { name: '新建 Conversation' }));
  expect(onNewConversation).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText(/Conversation 名称/)).not.toBeInTheDocument();

  rerender(<ConversationSwitcher
    conversations={conversations}
    virtualConversationId="virtual:new:one"
    routeName="主路线"
    onSelectConversation={onSelectConversation}
    onNewConversation={onNewConversation}
    onRenameConversation={vi.fn()}
    onArchiveConversation={vi.fn()}
  />);
  expect(screen.getAllByText('未命名 Conversation').length).toBeGreaterThan(0);
});

it('renames with keyboard focus restoration and archives without creating Workflow state', async () => {
  const onRenameConversation = vi.fn().mockResolvedValue(undefined);
  const onArchiveConversation = vi.fn().mockResolvedValue(undefined);
  render(<ConversationSwitcher
    conversations={conversations}
    selectedConversationId="conversation-a"
    routeName="主路线"
    onSelectConversation={vi.fn()}
    onNewConversation={vi.fn()}
    onRenameConversation={onRenameConversation}
    onArchiveConversation={onArchiveConversation}
  />);

  await userEvent.click(screen.getByRole('button', { name: '重命名 证据整理' }));
  const input = screen.getByRole('textbox', { name: '重命名 Conversation' });
  await userEvent.clear(input);
  await userEvent.type(input, '证据结论{Enter}');
  expect(onRenameConversation).toHaveBeenCalledWith('conversation-a', '证据结论');
  expect(screen.getByRole('button', { name: '重命名 证据整理' })).toHaveFocus();

  await userEvent.click(screen.getByRole('button', { name: '重命名 证据整理' }));
  await userEvent.type(screen.getByRole('textbox', { name: '重命名 Conversation' }), '{Escape}');
  expect(onRenameConversation).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '重命名 证据整理' })).toHaveFocus();

  await userEvent.click(screen.getByRole('button', { name: '归档 证据整理' }));
  expect(onArchiveConversation).toHaveBeenCalledWith('conversation-a');
});
