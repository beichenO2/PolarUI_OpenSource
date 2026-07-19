export type MemoryScope = 'user' | 'context';
export type MemoryStatus = 'active' | 'invalidated';

export interface MemorySource {
  kind: 'workflow' | 'user';
  commandId?: string;
  conversationId?: string;
}

export interface MemoryEvidence {
  kind: string;
  id: string;
  excerpt?: string;
}

export interface MemoryImpactScope {
  contextIds: string[] | 'all';
}

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  contextId: string | null;
  key: string;
  value: unknown;
  status: MemoryStatus;
  version: number;
  source: MemorySource;
  evidence: MemoryEvidence[];
  impactScope: MemoryImpactScope;
  createdAt: string;
  updatedAt: string;
}

export type MemoryListInput =
  | { scope: 'user'; contextId?: never }
  | { scope: 'context'; contextId: string };

export interface ReviseMemoryInput {
  value: unknown;
  expectedVersion: number;
  evidence?: MemoryEvidence[];
}

export interface InvalidateMemoryInput {
  expectedVersion: number;
  reason: string;
}

export class MemoryApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = 'MemoryApiError';
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new MemoryApiError(body?.error?.code ?? 'REQUEST_FAILED', response.status);
  }
  return body as T;
}

export async function listMemories(input: MemoryListInput, signal?: AbortSignal) {
  const query = input.scope === 'user'
    ? 'scope=user'
    : `scope=context&context=${encodeURIComponent(input.contextId)}`;
  const response = await request<{ memories: MemoryItem[] }>(`/api/memory?${query}`, { signal });
  return response.memories;
}

export async function listMemoryVersions(memoryId: string, signal?: AbortSignal) {
  const response = await request<{ versions: MemoryItem[] }>(
    `/api/memory/${encodeURIComponent(memoryId)}/versions`,
    { signal },
  );
  return response.versions;
}

export async function reviseMemory(
  memoryId: string,
  input: ReviseMemoryInput,
  signal?: AbortSignal,
) {
  const response = await request<{ memory: MemoryItem }>(
    `/api/memory/${encodeURIComponent(memoryId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    },
  );
  return response.memory;
}

export async function invalidateMemory(
  memoryId: string,
  input: InvalidateMemoryInput,
  signal?: AbortSignal,
) {
  const response = await request<{ memory: MemoryItem }>(
    `/api/memory/${encodeURIComponent(memoryId)}`,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    },
  );
  return response.memory;
}
