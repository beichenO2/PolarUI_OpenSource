import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRouteFromVersion,
  createConversation,
  createContext,
  getContextWorkspace,
  getRouteWorkspace,
  listContexts,
  renameContext,
  updateConversation,
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
    await getRouteWorkspace('route id');
    await getRouteWorkspace('route id', 'checkpoint/id');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/contexts',
      '/api/contexts/context%20id/workspace',
      '/api/routes/route%20id/workspace',
      '/api/routes/route%20id/workspace?checkpoint=checkpoint%2Fid',
    ]);
  });

  it('sends typed mutation bodies with same-origin credentials', async () => {
    const fetchMock = vi.fn(() => response({ ok: true }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await createContext('Project');
    await createConversation('route-1');
    await renameContext('context-1', { title: 'Renamed context' });
    await updateConversation('conversation-1', { title: 'Renamed', status: 'archived' });
    await createRouteFromVersion('context-1', { sourceCheckpointId: 'checkpoint-1', name: 'Route B' });
    expect(fetchMock.mock.calls.map(([url, init]) => ({
      url,
      method: init?.method,
      body: JSON.parse(String(init?.body)),
      credentials: init?.credentials,
    }))).toEqual([
      { url: '/api/contexts', method: 'POST', body: { title: 'Project' }, credentials: 'same-origin' },
      { url: '/api/routes/route-1/conversations', method: 'POST', body: {}, credentials: 'same-origin' },
      { url: '/api/contexts/context-1', method: 'PATCH', body: { title: 'Renamed context' }, credentials: 'same-origin' },
      { url: '/api/conversations/conversation-1', method: 'PATCH', body: { title: 'Renamed', status: 'archived' }, credentials: 'same-origin' },
      { url: '/api/contexts/context-1/routes', method: 'POST', body: { sourceCheckpointId: 'checkpoint-1', name: 'Route B' }, credentials: 'same-origin' },
    ]);
  });
});
