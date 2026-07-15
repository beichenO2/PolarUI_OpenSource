const prefix = 'polar-native:';
const returnPathKey = (productId: string) => prefix + productId + ':return-path';

function safeLocalPath(path: string) {
  return path.startsWith('/') && !path.startsWith('//') ? path : '/';
}

function normalizedLocalPath(path: string) {
  const url = new URL(safeLocalPath(path), 'https://polar.local');
  url.searchParams.sort();
  return url.pathname + url.search;
}

export const setReturnPath = (productId: string, path: string) =>
  localStorage.setItem(returnPathKey(productId), safeLocalPath(path));
export const takeReturnPath = (productId: string) => {
  const key = returnPathKey(productId);
  const value = safeLocalPath(localStorage.getItem(key) ?? '/');
  localStorage.removeItem(key);
  return value;
};
export const readDraft = (productId: string, path: string) =>
  localStorage.getItem(prefix + productId + ':draft:' + normalizedLocalPath(path)) ?? '';
export const writeDraft = (productId: string, path: string, value: string) =>
  localStorage.setItem(prefix + productId + ':draft:' + normalizedLocalPath(path), value);
