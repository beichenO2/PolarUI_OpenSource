import { describe, expect, it } from 'vitest';
import { createAssetService } from '../src/assets/service.js';

function fixture() {
  const objects: Array<Record<string, unknown>> = [];
  const bodies = new Map<string, Buffer>();
  let nextId = 0;
  const repository = {
    async findObject(userId: string, sha256: string, byteSize: number) {
      return objects.find((object) => object.userId === userId &&
        object.sha256 === sha256 && object.byteSize === byteSize) ?? null;
    },
    async createObject(record: Record<string, unknown>) {
      objects.push(record);
      return record;
    },
  };
  const store = {
    async put(key: string, body: Buffer) { bodies.set(key, body); },
  };
  const service = createAssetService({
    repository: repository as never,
    store: store as never,
    createId: () => `prepared-${++nextId}`,
  });
  return { service, objects, bodies };
}

describe('artifact preparation before Command finalization', () => {
  it('persists a content-addressed object and returns DB-ready immutable metadata without an artifact row', async () => {
    const { service, objects, bodies } = fixture();

    await expect(service.prepareArtifact('owner', {
      filename: '../result.txt',
      mediaType: 'text/plain; charset=utf-8',
      body: Buffer.from('result'),
    })).resolves.toEqual({
      status: 'ready',
      id: 'prepared-1',
      objectId: 'prepared-2',
      filename: '.._result.txt',
      mediaType: 'text/plain',
      byteSize: 6,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(objects).toHaveLength(1);
    expect(bodies).toHaveLength(1);
  });

  it('returns a failed artifact record when validation or object persistence fails', async () => {
    const { service, objects } = fixture();

    await expect(service.prepareArtifact('owner', {
      filename: '../empty.txt',
      mediaType: 'text/plain',
      body: Buffer.alloc(0),
    })).resolves.toEqual({
      status: 'failed',
      id: 'prepared-1',
      filename: '.._empty.txt',
      errorCode: 'INVALID_FILE_SIZE',
    });
    expect(objects).toHaveLength(0);
  });
});
