import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAssetService, AssetServiceError } from '../src/assets/service.js';

function fixture() {
  const objects: any[] = [];
  const attachments: any[] = [];
  const bodies = new Map<string, Buffer>();
  let id = 0;
  const repository = {
    async getThreadScope(userId: string, threadId: string) {
      return userId === 'owner' && threadId === 'thread'
        ? { contextId: 'context', routeId: 'route', threadId, stageKey: 'work' }
        : null;
    },
    async findObject(userId: string, sha256: string, byteSize: number) {
      return objects.find((item) => item.userId === userId && item.sha256 === sha256 && item.byteSize === byteSize) ?? null;
    },
    async createObject(record: any) { objects.push(record); return record; },
    async createAttachment(record: any) {
      const result = { id: record.id, filename: record.filename, created_at: new Date() };
      attachments.push(record);
      return result;
    },
    async listThreadAttachments() { return [{ kind: 'attachment', id: 'attachment-1' }]; },
    async listStageArtifacts() { return [{ kind: 'artifact', id: 'artifact-1' }]; },
    async getOwnedAsset(userId: string, _kind: string, assetId: string) {
      const attachment = attachments.find((item) => item.id === assetId && item.userId === userId);
      const object = attachment && objects.find((item) => item.id === attachment.objectId);
      return object ? { filename: attachment.filename, object } : null;
    },
  };
  const store = {
    async put(key: string, body: Buffer) { bodies.set(key, body); },
    async exists(key: string) { return bodies.has(key); },
    async open(key: string) {
      const body = bodies.get(key);
      if (!body) throw new Error('missing');
      return { stream: Readable.from(body), byteSize: body.byteLength };
    },
  };
  const service = createAssetService({ repository: repository as any, store, createId: () => `id-${++id}` });
  return { service, objects, attachments, bodies };
}

describe('asset service', () => {
  it('normalizes filenames, hashes bodies, and deduplicates objects per owner', async () => {
    const { service, objects, attachments } = fixture();
    const input = { filename: '../notes.txt', mediaType: 'text/plain; charset=utf-8', body: Buffer.from('hello') };
    await service.uploadAttachment('owner', 'thread', input);
    await service.uploadAttachment('owner', 'thread', input);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ userId: 'owner', mediaType: 'text/plain', byteSize: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(attachments.map((item) => item.filename)).toEqual(['.._notes.txt', '.._notes.txt']);
  });

  it('rejects empty and oversized files before persistence', async () => {
    const { service, objects } = fixture();
    await expect(service.uploadAttachment('owner', 'thread', {
      filename: 'empty.txt', mediaType: 'text/plain', body: Buffer.alloc(0),
    })).rejects.toMatchObject({ code: 'INVALID_FILE_SIZE', statusCode: 413 });
    await expect(service.uploadAttachment('owner', 'thread', {
      filename: 'large.bin', mediaType: 'application/octet-stream', body: Buffer.alloc(25 * 1024 * 1024 + 1),
    })).rejects.toMatchObject({ code: 'INVALID_FILE_SIZE', statusCode: 413 });
    expect(objects).toHaveLength(0);
  });

  it('hides unknown and cross-user threads and assets', async () => {
    const { service } = fixture();
    await expect(service.uploadAttachment('other', 'thread', {
      filename: 'private.txt', mediaType: 'text/plain', body: Buffer.from('secret'),
    })).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    await expect(service.openAsset('other', 'attachment', 'missing'))
      .rejects.toBeInstanceOf(AssetServiceError);
  });

  it('separates discussion attachments from accepted stage artifacts', async () => {
    const { service } = fixture();

    await expect(service.listThreadAttachments('owner', 'thread')).resolves.toEqual({
      attachments: [{ kind: 'attachment', id: 'attachment-1' }],
    });
    await expect(service.listStageArtifacts('owner', 'route', 'work')).resolves.toEqual({
      artifacts: [{ kind: 'artifact', id: 'artifact-1' }],
    });
  });
});
