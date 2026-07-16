import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRouteFromVersion,
  createContext,
  createThread,
  getContextWorkspace,
  getRouteWorkspace,
  listContexts,
  updateThread,
} from './api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

describe('workflow domain web client', () => {
  it('addresses context and route workspace resources', async () => {
    const fetchMock = vi.fn((url: string) => response({ url }));
    vi.stubGlobal('fetch', fetchMock);
    await listContexts();
    await getContextWorkspace('context id');
    await getRouteWorkspace('route id', 'future_stage');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/contexts',
      '/api/contexts/context%20id/workspace',
      '/api/routes/route%20id/workspace?stage=future_stage',
    ]);
  });

  it('sends typed mutation bodies with same-origin credentials', async () => {
    const fetchMock = vi.fn(() => response({ ok: true }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await createContext('Project');
    await createThread('route-1', { stageKey: 'discover', title: 'Topic' });
    await updateThread('thread-1', { title: 'Renamed' });
    await createRouteFromVersion('context-1', { sourceCheckpointId: 'checkpoint-1', name: 'Route B' });
    expect(fetchMock.mock.calls.map(([url, init]) => ({
      url,
      method: init?.method,
      body: JSON.parse(String(init?.body)),
      credentials: init?.credentials,
    }))).toEqual([
      { url: '/api/contexts', method: 'POST', body: { title: 'Project' }, credentials: 'same-origin' },
      { url: '/api/routes/route-1/threads', method: 'POST', body: { stageKey: 'discover', title: 'Topic' }, credentials: 'same-origin' },
      { url: '/api/threads/thread-1', method: 'PATCH', body: { title: 'Renamed' }, credentials: 'same-origin' },
      { url: '/api/contexts/context-1/routes', method: 'POST', body: { sourceCheckpointId: 'checkpoint-1', name: 'Route B' }, credentials: 'same-origin' },
    ]);
  });
});
