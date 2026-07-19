import { useRef, useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { WorkflowConversation } from '../domain/api';
import { ConversationSwitcher } from './ConversationSwitcher';
import { ConversationDrawer } from './ThreadDrawer';

const conversations: WorkflowConversation[] = [{
  id: 'conversation-a', contextId: 'context-a', routeId: 'route-a', title: '方案梳理',
  titleSource: 'agent', isPrimary: true, status: 'active',
  createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
}];

it('keeps mobile Conversation management secondary and restores focus when closed', async () => {
  const onNewConversation = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    return <>
      <ConversationSwitcher
        conversations={conversations}
        selectedConversationId="conversation-a"
        routeName="主路线"
        onSelectConversation={vi.fn()}
        onNewConversation={onNewConversation}
        onRenameConversation={vi.fn()}
        onArchiveConversation={vi.fn()}
      />
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>管理 Conversations</button>
      {open && <ConversationDrawer
        conversations={conversations}
        selectedConversationId="conversation-a"
        routeName="主路线"
        returnFocusRef={triggerRef}
        onClose={() => setOpen(false)}
        onSelectConversation={vi.fn()}
        onNewConversation={onNewConversation}
        onRenameConversation={vi.fn()}
        onArchiveConversation={vi.fn()}
      />}
    </>;
  }

  render(<Harness />);
  expect(screen.queryByRole('dialog', { name: 'Conversation 管理' })).not.toBeInTheDocument();
  const trigger = screen.getByRole('button', { name: '管理 Conversations' });
  await userEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: 'Conversation 管理' });
  expect(dialog).toBeInTheDocument();
  const dialogButtons = within(dialog).getAllByRole('button');
  const closeButton = within(dialog).getByRole('button', { name: '关闭 Conversation 管理' });
  expect(closeButton).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(dialogButtons.at(-1)).toHaveFocus();
  await userEvent.tab();
  expect(closeButton).toHaveFocus();
  const conversationHeadings = screen.getAllByRole('heading', { name: '方案梳理' });
  expect(new Set(conversationHeadings.map(({ id }) => id)).size).toBe(conversationHeadings.length);
  await userEvent.click(within(dialog).getByRole('button', { name: '新建 Conversation' }));
  expect(onNewConversation).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText(/标题|名称/)).not.toBeInTheDocument();

  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Conversation 管理' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
