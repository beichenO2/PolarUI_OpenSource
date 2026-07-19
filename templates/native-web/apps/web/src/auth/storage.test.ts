import { beforeEach, describe, expect, it } from 'vitest';
import { clearComposerDraft, readComposerDraft, writeComposerDraft } from './storage';

describe('Conversation composer draft storage', () => {
  beforeEach(() => localStorage.clear());

  const scope = {
    productId: 'demo',
    userId: 'user-a',
    contextId: 'context-a',
    routeId: 'route-a',
    conversationId: 'conversation-a',
  };

  it('isolates drafts by authenticated user and discussion scope', () => {
    writeComposerDraft(scope, 'draft A');

    expect(readComposerDraft(scope)).toBe('draft A');
    expect(readComposerDraft({ ...scope, userId: 'user-b' })).toBe('');
    expect(readComposerDraft({ ...scope, conversationId: 'conversation-b' })).toBe('');
  });

  it('isolates zero-Context and local virtual Conversation drafts', () => {
    const zeroContext = { productId: 'demo', userId: 'user-a' };
    const virtualA = { ...scope, conversationId: undefined, virtualConversationId: 'virtual-a' };
    const virtualB = { ...virtualA, virtualConversationId: 'virtual-b' };

    writeComposerDraft(zeroContext, 'first input');
    writeComposerDraft(virtualA, 'question A');

    expect(readComposerDraft(zeroContext)).toBe('first input');
    expect(readComposerDraft(virtualA)).toBe('question A');
    expect(readComposerDraft(virtualB)).toBe('');
  });

  it('uses no Stage or Thread segment and never reads a legacy stage note', () => {
    localStorage.setItem('polar-native:demo:draft:/contexts/context-a/routes/route-a/stages/discover', 'legacy note');
    writeComposerDraft(scope, 'send me');

    expect(Object.keys(localStorage).find((key) => key.includes('composer-draft'))).not.toMatch(/stage|thread/i);

    clearComposerDraft(scope);

    expect(readComposerDraft(scope)).toBe('');
  });
});
