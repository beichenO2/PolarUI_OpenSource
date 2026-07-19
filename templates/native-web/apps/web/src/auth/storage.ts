const prefix = 'polar-native:';
const returnPathKey = (productId: string) => prefix + productId + ':return-path';

function safeLocalPath(path: string) {
  return path.startsWith('/') && !path.startsWith('//') ? path : '/';
}

export const setReturnPath = (productId: string, path: string) =>
  localStorage.setItem(returnPathKey(productId), safeLocalPath(path));
export const takeReturnPath = (productId: string) => {
  const key = returnPathKey(productId);
  const value = safeLocalPath(localStorage.getItem(key) ?? '/');
  localStorage.removeItem(key);
  return value;
};
export interface ComposerDraftScope {
  productId: string;
  userId: string;
  contextId?: string;
  routeId?: string;
  conversationId?: string;
  virtualConversationId?: string;
}

export const composerDraftKey = (scope: ComposerDraftScope) => {
  const conversationScope = scope.conversationId
    ? `conversation:${scope.conversationId}`
    : scope.virtualConversationId
      ? `virtual:${scope.virtualConversationId}`
      : scope.contextId
        ? 'virtual:primary'
        : 'virtual:start';
  return prefix + [
    scope.productId,
    'composer-draft',
    scope.userId,
    scope.contextId ?? 'zero-context',
    scope.routeId ?? 'zero-route',
    conversationScope,
  ].map(encodeURIComponent).join(':');
};

export const readComposerDraft = (scope: ComposerDraftScope) =>
  localStorage.getItem(composerDraftKey(scope)) ?? '';

export const writeComposerDraft = (scope: ComposerDraftScope, value: string) => {
  const key = composerDraftKey(scope);
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
};

export const clearComposerDraft = (scope: ComposerDraftScope) =>
  localStorage.removeItem(composerDraftKey(scope));
