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
  contextId: string;
  routeId: string;
  stageKey: string;
  threadId: string;
}

export const composerDraftKey = (scope: ComposerDraftScope) =>
  prefix + [
    scope.productId,
    'composer-draft',
    scope.userId,
    scope.contextId,
    scope.routeId,
    scope.stageKey,
    scope.threadId,
  ].map(encodeURIComponent).join(':');

export const readComposerDraft = (scope: ComposerDraftScope) =>
  localStorage.getItem(composerDraftKey(scope)) ?? '';

export const writeComposerDraft = (scope: ComposerDraftScope, value: string) => {
  const key = composerDraftKey(scope);
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
};

export const clearComposerDraft = (scope: ComposerDraftScope) =>
  localStorage.removeItem(composerDraftKey(scope));
