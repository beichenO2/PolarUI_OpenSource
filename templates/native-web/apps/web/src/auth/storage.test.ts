import { beforeEach, describe, expect, it } from 'vitest';
import { clearComposerDraft, readComposerDraft, writeComposerDraft } from './storage';

describe('discussion composer draft storage', () => {
  beforeEach(() => localStorage.clear());

  const scope = {
    productId: 'demo',
    userId: 'user-a',
    contextId: 'context-a',
    routeId: 'route-a',
    stageKey: 'discover',
    threadId: 'thread-a',
  };

  it('isolates drafts by authenticated user and discussion scope', () => {
    writeComposerDraft(scope, 'draft A');

    expect(readComposerDraft(scope)).toBe('draft A');
    expect(readComposerDraft({ ...scope, userId: 'user-b' })).toBe('');
    expect(readComposerDraft({ ...scope, threadId: 'thread-b' })).toBe('');
  });

  it('clears a sent draft without reading a legacy stage note', () => {
    localStorage.setItem('polar-native:demo:draft:/contexts/context-a/routes/route-a/stages/discover', 'legacy note');
    writeComposerDraft(scope, 'send me');
    clearComposerDraft(scope);

    expect(readComposerDraft(scope)).toBe('');
  });
});
