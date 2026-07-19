import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryApiError,
  invalidateMemory,
  listMemories,
  listMemoryVersions,
  reviseMemory,
  type MemoryItem,
} from './api';

const memory: MemoryItem = {
  id: 'memory/a b',
  scope: 'context',
  contextId: 'context/研发 & 运营',
  key: 'goal',
  value: { outcome: 'ship' },
  status: 'active',
  version: 3,
  source: { kind: 'workflow', commandId: 'command-1' },
  evidence: [{ kind: 'message', id: 'message-1', excerpt: 'ship it' }],
  impactScope: { contextIds: ['context/研发 & 运营'] },
  createdAt: '2026-07-17T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('memory API client', () => {
  it('lists user and encoded Context memory with credentials and AbortSignal', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ memories: [memory] }))
      .mockResolvedValueOnce(Response.json({ memories: [memory] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listMemories({ scope: 'user' }, signal)).resolves.toEqual([memory]);
    await expect(listMemories({ scope: 'context', contextId: 'context/研发 & 运营' }, signal))
      .resolves.toEqual([memory]);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/memory?scope=user', {
      credentials: 'same-origin', signal,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/memory?scope=context&context=context%2F%E7%A0%94%E5%8F%91%20%26%20%E8%BF%90%E8%90%A5',
      { credentials: 'same-origin', signal },
    );
  });

  it('loads the complete version history through an encoded memory id', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ versions: [memory] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listMemoryVersions('memory/a b', signal)).resolves.toEqual([memory]);
    expect(fetchMock).toHaveBeenCalledWith('/api/memory/memory%2Fa%20b/versions', {
      credentials: 'same-origin', signal,
    });
  });

  it('revises JSON values with expectedVersion and JSON content type', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ memory }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reviseMemory('memory/a b', {
      value: null,
      expectedVersion: 3,
      evidence: [{ kind: 'message', id: 'message-2' }],
    }, signal)).resolves.toEqual(memory);
    expect(fetchMock).toHaveBeenCalledWith('/api/memory/memory%2Fa%20b', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        value: null,
        expectedVersion: 3,
        evidence: [{ kind: 'message', id: 'message-2' }],
      }),
      signal,
    });
  });

  it('invalidates through DELETE with an auditable reason and expectedVersion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ memory }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(invalidateMemory('memory/a b', {
      expectedVersion: 3,
      reason: '目标已经过期',
    })).resolves.toEqual(memory);
    expect(fetchMock).toHaveBeenCalledWith('/api/memory/memory%2Fa%20b', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 3, reason: '目标已经过期' }),
      signal: undefined,
    });
  });

  it('preserves the server error code and status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      error: { code: 'MEMORY_VERSION_CONFLICT' },
    }, { status: 409 })));

    const error = await listMemories({ scope: 'user' }).catch((value) => value);
    expect(error).toBeInstanceOf(MemoryApiError);
    expect(error).toMatchObject({ code: 'MEMORY_VERSION_CONFLICT', status: 409 });
  });
});
