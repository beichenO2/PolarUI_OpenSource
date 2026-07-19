import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import type { WorkflowConversation } from '../domain/api';
import { ConversationSwitcher } from './ConversationSwitcher';

export interface ConversationDrawerProps {
  conversations: WorkflowConversation[];
  selectedConversationId?: string;
  virtualConversationId?: string;
  routeName: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose(): void;
  onSelectConversation(conversationId: string): Promise<void> | void;
  onNewConversation(): Promise<void> | void;
  onRenameConversation(conversationId: string, title: string): Promise<void> | void;
  onArchiveConversation(conversationId: string): Promise<void> | void;
}

export function ConversationDrawer({ returnFocusRef, onClose, ...switcherProps }: ConversationDrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const close = () => {
    onClose();
    queueMicrotask(() => returnFocusRef?.current?.focus());
  };

  const containFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab' || event.defaultPrevented) return;

    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }

    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return <aside
    className="thread-drawer conversation-drawer"
    role="dialog"
    aria-modal="true"
    aria-labelledby="conversation-drawer-heading"
    tabIndex={-1}
    onKeyDown={containFocus}
  >
    <header className="thread-drawer-header">
      <div><p className="eyebrow">移动管理</p><h2 id="conversation-drawer-heading">Conversation 管理</h2></div>
      <button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭 Conversation 管理" onClick={close}>×</button>
    </header>
    <ConversationSwitcher {...switcherProps} />
  </aside>;
}

/** @deprecated Transitional name retained for imports during the conversation-first migration. */
export const ThreadDrawer = ConversationDrawer;
