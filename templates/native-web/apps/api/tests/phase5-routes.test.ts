import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const origin = 'http://127.0.0.1:3920';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/test', AUTH_PEPPER: 'x'.repeat(32), PUBLIC_APP_ORIGIN: origin, COOKIE_SECURE: 'false', SMTP_HOST: 'localhost', SMTP_PORT: '1025', SMTP_FROM: 'Demo <demo@example.test>' });
const manifest = { contract_version: '1.0' as const, product: { id: 'demo', name: 'Demo', context_label: '项目', route_label: '路线' }, workflow: { id: 'demo', endpoint: 'http://workflow.test/run' }, stages: [{ key: 'work', label: '工作', component_key: 'document_workspace' as const, internal_states: ['start'], actions: [] }] };
const ids = { user: '10000000-0000-4000-8000-000000000001', thread: '10000000-0000-4000-8000-000000000002', asset: '10000000-0000-4000-8000-000000000003', proposal: '10000000-0000-4000-8000-000000000004', conversation: '10000000-0000-4000-8000-000000000005', route: '10000000-0000-4000-8000-000000000006' };
const apps: any[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map((app) => app.close())); });
function setup() {
  const authService = { getSessionUser: vi.fn(async (token: string) => token === 'token' ? { id: ids.user, email: 'owner@example.test', username: 'owner' } : null) };
  const assetService = {
    listThreadAttachments: vi.fn(async () => ({ attachments: [{ kind: 'attachment', id: ids.asset, filename: 'notes.txt', mediaType: 'text/plain', byteSize: 5, sha256: 'a'.repeat(64) }] })),
    listStageArtifacts: vi.fn(async () => ({ artifacts: [{ kind: 'artifact', id: ids.asset, filename: 'result.txt', mediaType: 'text/plain', byteSize: 6, sha256: 'b'.repeat(64) }] })),
    uploadAttachment: vi.fn(async (_user: string, _thread: string, input: any) => ({ attachment: { id: ids.asset, filename: input.filename } })),
    openAsset: vi.fn(async () => ({ filename: 'notes.txt', object: { mediaType: 'text/plain', byteSize: 5 }, stream: Readable.from('hello') })),
  };
  const memoryRepository = { list: vi.fn(async () => [{ id: ids.proposal, status: 'pending' }]), decide: vi.fn(async (_user: string, _id: string, decision: string) => ({ proposal: { id: ids.proposal, status: decision }, alreadyDecided: false })) };
  const archiveRepository = { list: vi.fn(async () => [{ id: ids.conversation, title: 'Old', readOnly: true }]), detail: vi.fn(async (_user: string, id: string) => id === ids.conversation ? { conversation: { id, readOnly: true }, messages: [], attachments: [] } : null) };
  const app = buildApp({ manifest, staticRoot: null, config, authService: authService as any, assetService: assetService as any, memoryRepository: memoryRepository as any, archiveRepository: archiveRepository as any });
  apps.push(app); return { app, assetService, memoryRepository };
}
const cookie = 'polar_session=token';

describe('Phase 5 owned routes', () => {
  it('requires auth/origin and accepts bounded octet-stream attachments', async () => {
    const { app, assetService } = setup();
    expect((await app.inject({ method: 'GET', url: `/api/threads/${ids.thread}/attachments` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/threads/${ids.thread}/attachments`, headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'notes.txt' }, payload: Buffer.from('hello') })).statusCode).toBe(403);
    const uploaded = await app.inject({ method: 'POST', url: `/api/threads/${ids.thread}/attachments`, headers: { cookie, origin, 'content-type': 'application/octet-stream', 'x-file-media-type': 'text/plain', 'x-file-name': encodeURIComponent('研究 笔记.txt') }, payload: Buffer.from('hello') });
    expect(uploaded.statusCode).toBe(201);
    expect(assetService.uploadAttachment).toHaveBeenCalledWith(ids.user, ids.thread, expect.objectContaining({ filename: '研究 笔记.txt', mediaType: 'text/plain', body: Buffer.from('hello') }));
  });
  it('exposes attachments and accepted artifacts through separate owned routes', async () => {
    const { app, assetService } = setup();
    const attachments = await app.inject({ method: 'GET', url: `/api/threads/${ids.thread}/attachments`, headers: { cookie } });
    const artifacts = await app.inject({ method: 'GET', url: `/api/routes/${ids.route}/stages/work/artifacts`, headers: { cookie } });

    expect(attachments.json().attachments).toHaveLength(1);
    expect(artifacts.json().artifacts).toHaveLength(1);
    expect(assetService.listThreadAttachments).toHaveBeenCalledWith(ids.user, ids.thread);
    expect(assetService.listStageArtifacts).toHaveBeenCalledWith(ids.user, ids.route, 'work');
  });
  it('serves owned assets with safe download headers', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: `/api/assets/attachment/${ids.asset}/download`, headers: { cookie } });
    expect(response.statusCode).toBe(200); expect(response.body).toBe('hello');
    expect(response.headers['content-disposition']).toContain('attachment;'); expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
  it('lists and explicitly decides memory proposals', async () => {
    const { app, memoryRepository } = setup();
    expect((await app.inject({ method: 'GET', url: `/api/memory-proposals?thread=${ids.thread}`, headers: { cookie } })).json().proposals).toHaveLength(1);
    const decision = await app.inject({ method: 'POST', url: `/api/memory-proposals/${ids.proposal}/decision`, headers: { cookie, origin }, payload: { decision: 'adopted' } });
    expect(decision.statusCode).toBe(200); expect(memoryRepository.decide).toHaveBeenCalledWith(ids.user, ids.proposal, 'adopted', expect.any(Date));
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
