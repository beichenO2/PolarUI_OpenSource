import { createHash, randomUUID } from 'node:crypto';
import type { AssetRepository, ThreadScope } from './repository.js';
import type { ObjectStore } from './storage.js';
import { objectKey } from './storage.js';
import type { PreparedArtifact } from '../commands/types.js';

const maximumBytes = 25 * 1024 * 1024;

export class AssetServiceError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) {
    super(code);
    this.name = 'AssetServiceError';
  }
}

function filename(value: string) {
  const normalized = value.normalize('NFC').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  if (!normalized || normalized.length > 255 || normalized === '.' || normalized === '..') {
    throw new AssetServiceError('INVALID_FILENAME', 400);
  }
  return normalized;
}

function mediaType(value: string) {
  const normalized = value.split(';', 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)) {
    throw new AssetServiceError('INVALID_MEDIA_TYPE', 400);
  }
  return normalized;
}

export function createAssetService(options: {
  repository: AssetRepository;
  store: ObjectStore;
  createId?: () => string;
}) {
  const createId = options.createId ?? randomUUID;

  async function persistObject(userId: string, body: Buffer, rawMediaType: string) {
    if (body.byteLength === 0 || body.byteLength > maximumBytes) {
      throw new AssetServiceError('INVALID_FILE_SIZE', 413);
    }
    const type = mediaType(rawMediaType);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const existing = await options.repository.findObject(userId, sha256, body.byteLength);
    if (existing) return existing;
    const key = objectKey(userId, sha256);
    await options.store.put(key, body);
    return options.repository.createObject({
      id: createId(), userId, storageKey: key, sha256,
      byteSize: body.byteLength, mediaType: type, status: 'ready',
    });
  }

  async function uploadAttachment(userId: string, threadId: string, input: {
    filename: string; mediaType: string; body: Buffer;
  }) {
    const scope = await options.repository.getThreadScope(userId, threadId);
    if (!scope) throw new AssetServiceError('NOT_FOUND', 404);
    const object = await persistObject(userId, input.body, input.mediaType);
    const attachment = await options.repository.createAttachment({
      ...scope, id: createId(), userId, objectId: object.id, filename: filename(input.filename),
    });
    return { attachment: { ...attachment, mediaType: object.mediaType, byteSize: object.byteSize, sha256: object.sha256 } };
  }

  async function stageAttachment(userId: string, input: {
    filename: string;
    mediaType: string;
    body: Buffer;
  }) {
    const safeName = filename(input.filename);
    const object = await persistObject(userId, input.body, input.mediaType);
    const staged = await options.repository.createStagedAttachment({
      id: createId(),
      userId,
      objectId: object.id,
      filename: safeName,
    });
    return {
      id: staged.id,
      filename: staged.filename,
      mediaType: object.mediaType,
      byteSize: object.byteSize,
      sha256: object.sha256,
      status: staged.status,
      conversationId: null,
      createdAt: staged.createdAt,
    };
  }

  async function deleteStagedAttachment(userId: string, attachmentId: string) {
    if (!await options.repository.deleteStagedAttachment(userId, attachmentId)) {
      throw new AssetServiceError('NOT_FOUND', 404);
    }
  }

  async function listConversationAttachments(userId: string, conversationId: string) {
    const attachments = await options.repository.listConversationAttachments(userId, conversationId);
    if (!attachments) throw new AssetServiceError('NOT_FOUND', 404);
    return { attachments };
  }

  async function listThreadAttachments(userId: string, threadId: string) {
    const scope = await options.repository.getThreadScope(userId, threadId);
    if (!scope) throw new AssetServiceError('NOT_FOUND', 404);
    return { attachments: await options.repository.listThreadAttachments(userId, threadId) };
  }

  async function listStageArtifacts(userId: string, routeId: string, stageKey: string) {
    return { artifacts: await options.repository.listStageArtifacts(userId, routeId, stageKey) };
  }

  async function openAsset(userId: string, kind: 'attachment' | 'artifact' | 'archive', id: string) {
    const asset = await options.repository.getOwnedAsset(userId, kind, id);
    if (!asset) throw new AssetServiceError('NOT_FOUND', 404);
    const opened = await options.store.open(asset.object.storageKey);
    if (opened.byteSize !== asset.object.byteSize) throw new AssetServiceError('ASSET_CORRUPT', 503);
    return { ...asset, stream: opened.stream };
  }

  async function saveArtifact(userId: string, commandId: string, scope: ThreadScope, input: {
    filename: string; mediaType: string; body: Buffer;
  }) {
    const prepared = await prepareArtifact(userId, input);
    if (prepared.status === 'ready') {
      return await options.repository.createArtifact({
        ...scope,
        id: prepared.id,
        userId,
        objectId: prepared.objectId,
        commandId,
        filename: prepared.filename,
      });
    }
    return options.repository.createFailedArtifact({
      ...scope,
      id: prepared.id,
      userId,
      commandId,
      filename: prepared.filename,
      errorCode: prepared.errorCode,
    });
  }

  async function prepareArtifact(userId: string, input: {
    filename: string;
    mediaType: string;
    body: Buffer;
  }): Promise<PreparedArtifact> {
    const id = createId();
    try {
      const safeName = filename(input.filename);
      const object = await persistObject(userId, input.body, input.mediaType);
      return {
        status: 'ready',
        id,
        objectId: object.id,
        filename: safeName,
        mediaType: object.mediaType,
        byteSize: object.byteSize,
        sha256: object.sha256,
      };
    } catch (error) {
      return {
        status: 'failed',
        id,
        filename: input.filename.replace(/[\\/\u0000-\u001f\u007f]/g, '_')
          .trim().slice(0, 255) || 'artifact.bin',
        errorCode: error instanceof AssetServiceError ? error.code : 'ARTIFACT_STORAGE_FAILED',
      };
    }
  }

  return {
    uploadAttachment,
    stageAttachment,
    deleteStagedAttachment,
    listThreadAttachments,
    listConversationAttachments,
    listStageArtifacts,
    openAsset,
    persistObject,
    prepareArtifact,
    saveArtifact,
  };
}

export type AssetService = ReturnType<typeof createAssetService>;
export type { ThreadScope };
