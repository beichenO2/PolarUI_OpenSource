import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AssetServiceError } from '../src/assets/service.js';
import { loadConfig } from '../src/config.js';
import { MemoryServiceError } from '../src/memory/service.js';

const origin = 'http://127.0.0.1:3920';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/test', AUTH_PEPPER: 'x'.repeat(32), PUBLIC_APP_ORIGIN: origin, COOKIE_SECURE: 'false', SMTP_HOST: 'localhost', SMTP_PORT: '1025', SMTP_FROM: 'Demo <demo@example.test>' });
const manifest = { contract_version: '1.0' as const, product: { id: 'demo', name: 'Demo', context_label: '项目', route_label: '路线' }, workflow: { id: 'demo', endpoint: 'http://workflow.test/run' }, stages: [{ key: 'work', label: '工作', component_key: 'document_workspace' as const, internal_states: ['start'], actions: [] }] };
const ids = { user: '10000000-0000-4000-8000-000000000001', thread: '10000000-0000-4000-8000-000000000002', asset: '10000000-0000-4000-8000-000000000003', proposal: '10000000-0000-4000-8000-000000000004', conversation: '10000000-0000-4000-8000-000000000005', route: '10000000-0000-4000-8000-000000000006' };
const apps: any[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map((app) => app.close())); });
type MemoryServiceOverrides = Partial<{
  list: (...args: any[]) => Promise<any>;
  listVersions: (...args: any[]) => Promise<any>;
  revise: (...args: any[]) => Promise<any>;
  invalidate: (...args: any[]) => Promise<any>;
}>;
function setup(memoryServiceOverrides: MemoryServiceOverrides = {}) {
  const authService = { getSessionUser: vi.fn(async (token: string) => token === 'token' ? { id: ids.user, email: 'owner@example.test', username: 'owner' } : null) };
  const assetService = {
    stageAttachment: vi.fn(async (_user: string, input: any) => ({ id: ids.asset, filename: input.filename, mediaType: input.mediaType, byteSize: input.body.byteLength, sha256: 'a'.repeat(64), status: 'pending', conversationId: null })),
    deleteStagedAttachment: vi.fn(async () => undefined),
    listConversationAttachments: vi.fn(async () => ({ attachments: [{ kind: 'attachment', id: ids.asset, filename: 'notes.txt', mediaType: 'text/plain', byteSize: 5, sha256: 'a'.repeat(64) }] })),
    listStageArtifacts: vi.fn(async () => ({ artifacts: [{ kind: 'artifact', id: ids.asset, filename: 'result.txt', mediaType: 'text/plain', byteSize: 6, sha256: 'b'.repeat(64) }] })),
    openAsset: vi.fn(async () => ({ filename: 'notes.txt', object: { mediaType: 'text/plain', byteSize: 5 }, stream: Readable.from('hello') })),
  };
  const memoryHistory = [1, 2].map((version) => ({
    id: ids.proposal,
    scope: 'user' as const,
    contextId: null,
    key: 'tone',
    value: version === 1 ? 'brief' : 'concise',
    status: 'active' as const,
    version,
    source: { kind: 'user' as const },
    evidence: [],
    impactScope: { contextIds: 'all' as const },
    createdAt: new Date('2026-07-18T07:00:00.000Z'),
    updatedAt: new Date(`2026-07-18T07:00:0${version}.000Z`),
  }));
  const memoryService = {
    list: vi.fn(memoryServiceOverrides.list ?? (async () => [memoryHistory[1]])),
    listVersions: vi.fn(memoryServiceOverrides.listVersions ?? (async () => memoryHistory)),
    revise: vi.fn(memoryServiceOverrides.revise ?? (async (_user: string, id: string, input: any) => ({ id, scope: 'user', status: 'active', version: input.expectedVersion + 1, value: input.value }))),
    invalidate: vi.fn(memoryServiceOverrides.invalidate ?? (async (_user: string, id: string, input: any) => ({ id, scope: 'user', status: 'invalidated', version: input.expectedVersion + 1, value: null }))),
  };
  const archiveRepository = { list: vi.fn(async () => [{ id: ids.conversation, title: 'Old', readOnly: true }]), detail: vi.fn(async (_user: string, id: string) => id === ids.conversation ? { conversation: { id, readOnly: true }, messages: [], attachments: [] } : null) };
  const app = buildApp({ manifest, staticRoot: null, config, authService: authService as any, assetService: assetService as any, memoryService: memoryService as any, archiveRepository: archiveRepository as any });
  apps.push(app); return { app, assetService, memoryService, memoryHistory };
}
const cookie = 'polar_session=token';

describe('Phase 5 owned routes', () => {
  it('stages bounded octet-stream attachments before a workflow scope exists', async () => {
    const { app, assetService } = setup();
    expect((await app.inject({ method: 'POST', url: '/api/attachments/staged', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'notes.txt' }, payload: Buffer.from('hello') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/attachments/staged', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'notes.txt' }, payload: Buffer.from('hello') })).statusCode).toBe(403);
    const uploaded = await app.inject({ method: 'POST', url: '/api/attachments/staged', headers: { cookie, origin, 'content-type': 'application/octet-stream', 'x-file-media-type': 'text/plain', 'x-file-name': encodeURIComponent('研究 笔记.txt') }, payload: Buffer.from('hello') });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().attachment).toMatchObject({ id: ids.asset, status: 'pending', conversationId: null });
    expect(assetService.stageAttachment).toHaveBeenCalledWith(ids.user, expect.objectContaining({ filename: '研究 笔记.txt', mediaType: 'text/plain', body: Buffer.from('hello') }));
    expect((await app.inject({ method: 'POST', url: `/api/threads/${ids.thread}/attachments`, headers: { cookie, origin, 'content-type': 'application/octet-stream', 'x-file-name': 'notes.txt' }, payload: Buffer.from('hello') })).statusCode).toBe(404);
  });
  it('deletes staged attachments and lists adopted conversation attachments through exact owned routes', async () => {
    const { app, assetService } = setup();
    expect((await app.inject({ method: 'DELETE', url: `/api/attachments/staged/${ids.asset}`, headers: { cookie } })).statusCode).toBe(403);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/attachments/staged/${ids.asset}`, headers: { cookie, origin } });
    const attachments = await app.inject({ method: 'GET', url: `/api/conversations/${ids.conversation}/attachments`, headers: { cookie } });

    expect(deleted.statusCode).toBe(204);
    expect(attachments.json().attachments).toHaveLength(1);
    expect(assetService.deleteStagedAttachment).toHaveBeenCalledWith(ids.user, ids.asset);
    expect(assetService.listConversationAttachments).toHaveBeenCalledWith(ids.user, ids.conversation);
    expect((await app.inject({ method: 'GET', url: `/api/threads/${ids.thread}/attachments`, headers: { cookie } })).statusCode).toBe(404);
  });
  it('serves owned assets with safe download headers', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: `/api/assets/attachment/${ids.asset}/download`, headers: { cookie } });
    expect(response.statusCode).toBe(200); expect(response.body).toBe('hello');
    expect(response.headers['content-disposition']).toContain('attachment;'); expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
  it('preserves expected asset service 4xx errors', async () => {
    const { app, assetService } = setup();
    assetService.stageAttachment.mockRejectedValueOnce(new AssetServiceError('INVALID_FILE_SIZE', 413));

    const response = await app.inject({
      method: 'POST',
      url: '/api/attachments/staged',
      headers: { cookie, origin, 'content-type': 'application/octet-stream', 'x-file-name': 'notes.txt' },
      payload: Buffer.from('hello'),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ error: { code: 'INVALID_FILE_SIZE' } });
  });
  it('maps unknown attachment and asset failures to a safe 503 envelope', async () => {
    const { app, assetService } = setup();
    const secret = 'postgresql://asset_admin:do-not-expose@db.internal/assets ~/app.db';
    assetService.stageAttachment.mockRejectedValueOnce(new Error(secret));
    assetService.openAsset.mockRejectedValueOnce(new Error(secret));
    assetService.listConversationAttachments.mockRejectedValueOnce(new Error(secret));

    const responses = [
      await app.inject({
        method: 'POST',
        url: '/api/attachments/staged',
        headers: { cookie, origin, 'content-type': 'application/octet-stream', 'x-file-name': 'notes.txt' },
        payload: Buffer.from('hello'),
      }),
      await app.inject({
        method: 'GET',
        url: `/api/assets/attachment/${ids.asset}/download`,
        headers: { cookie },
      }),
      await app.inject({
        method: 'GET',
        url: `/api/conversations/${ids.conversation}/attachments`,
        headers: { cookie },
      }),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: { code: 'ASSET_SERVICE_UNAVAILABLE' } });
      expect(response.body).not.toContain('asset_admin');
      expect(response.body).not.toContain('~/app.db');
    }
  });
  it('exposes exactly two versioned memory layers as direct metadata operations', async () => {
    const { app, memoryService, memoryHistory } = setup();
    expect((await app.inject({ method: 'GET', url: '/api/memory?scope=user' })).statusCode).toBe(401);

    const userMemory = await app.inject({ method: 'GET', url: '/api/memory?scope=user', headers: { cookie } });
    expect(userMemory.statusCode).toBe(200);
    expect(userMemory.json().memories).toHaveLength(1);
    expect(memoryService.list).toHaveBeenCalledWith(ids.user, { scope: 'user' });

    const contextMemory = await app.inject({ method: 'GET', url: `/api/memory?scope=context&context=${ids.conversation}`, headers: { cookie } });
    expect(contextMemory.statusCode).toBe(200);
    expect(memoryService.list).toHaveBeenCalledWith(ids.user, { scope: 'context', contextId: ids.conversation });

    const versions = await app.inject({ method: 'GET', url: `/api/memory/${ids.proposal}/versions`, headers: { cookie } });
    expect(versions.json().versions).toEqual(memoryHistory.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })));

    expect((await app.inject({ method: 'PATCH', url: `/api/memory/${ids.proposal}`, headers: { cookie }, payload: { value: 'launch', expectedVersion: 2 } })).statusCode).toBe(403);
    const revised = await app.inject({ method: 'PATCH', url: `/api/memory/${ids.proposal}`, headers: { cookie, origin }, payload: { value: 'launch', expectedVersion: 2, evidence: [] } });
    expect(revised.statusCode).toBe(200);
    expect(revised.json().memory).toMatchObject({ value: 'launch', version: 3 });
    expect(memoryService.revise).toHaveBeenCalledWith(ids.user, ids.proposal, { value: 'launch', expectedVersion: 2, evidence: [] });

    const invalidated = await app.inject({ method: 'DELETE', url: `/api/memory/${ids.proposal}`, headers: { cookie, origin }, payload: { expectedVersion: 3, reason: 'No longer true' } });
    expect(invalidated.statusCode).toBe(200);
    expect(invalidated.json().memory).toMatchObject({ status: 'invalidated', version: 4 });
    expect(memoryService.invalidate).toHaveBeenCalledWith(ids.user, ids.proposal, { expectedVersion: 3, reason: 'No longer true' });

    for (const scope of ['route', 'stage', 'thread']) {
      expect((await app.inject({ method: 'GET', url: `/api/memory?scope=${scope}`, headers: { cookie } })).statusCode).toBe(400);
    }
  });

  it('rejects malformed memory query and mutation bodies with INVALID_REQUEST', async () => {
    const { app, memoryService } = setup();
    const malformedQuery = await app.inject({
      method: 'GET',
      url: '/api/memory?scope=context&context=not-a-uuid',
      headers: { cookie },
    });
    const malformedRevision = await app.inject({
      method: 'PATCH',
      url: `/api/memory/${ids.proposal}`,
      headers: { cookie, origin },
      payload: { expectedVersion: 1 },
    });
    const malformedInvalidation = await app.inject({
      method: 'DELETE',
      url: `/api/memory/${ids.proposal}`,
      headers: { cookie, origin },
      payload: { expectedVersion: 1, reason: '   ' },
    });

    for (const response of [malformedQuery, malformedRevision, malformedInvalidation]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: 'INVALID_REQUEST' } });
    }
    expect(memoryService.list).not.toHaveBeenCalled();
    expect(memoryService.revise).not.toHaveBeenCalled();
    expect(memoryService.invalidate).not.toHaveBeenCalled();
  });

  it('maps a real MemoryServiceError NOT_FOUND to 404', async () => {
    const { app } = setup({
      listVersions: async () => {
        throw new MemoryServiceError('NOT_FOUND', 404);
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/memory/${ids.proposal}/versions`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'NOT_FOUND' } });
  });

  it('maps a real MemoryServiceError version conflict to 409', async () => {
    const { app } = setup({
      revise: async () => {
        throw new MemoryServiceError('MEMORY_VERSION_CONFLICT', 409);
      },
    });
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/memory/${ids.proposal}`,
      headers: { cookie, origin },
      payload: { value: 'launch', expectedVersion: 2 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'MEMORY_VERSION_CONFLICT' } });
  });

  it('maps an unknown memory service failure to the safe 503 envelope', async () => {
    const { app } = setup({
      list: async () => {
        throw new Error('postgres credentials leaked here');
      },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/memory?scope=user',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: 'MEMORY_SERVICE_UNAVAILABLE' } });
    expect(response.body).not.toContain('postgres credentials');
  });

  it('does not expose the legacy five-layer proposal/decision API', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: `/api/memory-proposals?thread=${ids.thread}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/memory-proposals/${ids.proposal}/decision`, headers: { cookie, origin }, payload: { decision: 'adopted' } })).statusCode).toBe(404);
  });
  it('exposes imported conversations as read-only owned archives', async () => {
    const { app } = setup();
    const list = await app.inject({ method: 'GET', url: '/api/archive/conversations', headers: { cookie } });
    expect(list.json().conversations[0]).toMatchObject({ title: 'Old', readOnly: true });
    const detail = await app.inject({ method: 'GET', url: `/api/archive/conversations/${ids.conversation}`, headers: { cookie } });
    expect(detail.json().conversation).toMatchObject({ readOnly: true });
    expect((await app.inject({ method: 'POST', url: `/api/archive/conversations/${ids.conversation}`, headers: { cookie, origin }, payload: {} })).statusCode).toBe(404);
  });
});
