import type { DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { expireStaleAttachmentClaims } from '../commands/attachment-claims.js';

export interface AssetObjectRecord {
  id: string;
  userId: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
  status: 'pending' | 'ready' | 'failed';
}

export interface ThreadScope {
  contextId: string;
  routeId: string;
  threadId: string;
  stageKey: string;
}

export interface StagedAttachmentRecord {
  id: string;
  userId: string;
  objectId: string;
  filename: string;
  status: 'pending' | 'adopted';
  createdAt: Date;
}

function mapObject(row: Record<string, unknown>): AssetObjectRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    storageKey: String(row.storage_key),
    sha256: String(row.sha256),
    byteSize: Number(row.byte_size),
    mediaType: String(row.media_type),
    status: row.status as AssetObjectRecord['status'],
  };
}

export function createAssetRepository(pool: DatabasePool) {
  async function getThreadScope(userId: string, threadId: string): Promise<ThreadScope | null> {
    const result = await pool.query(
      'SELECT t.context_id, t.route_id, t.id AS thread_id, t.stage_key ' +
      'FROM workflow_threads t JOIN contexts c ON c.id = t.context_id ' +
      'WHERE t.id = $1 AND c.user_id = $2',
      [threadId, userId],
    );
    const row = result.rows[0];
    return row ? {
      contextId: row.context_id,
      routeId: row.route_id,
      threadId: row.thread_id,
      stageKey: row.stage_key,
    } : null;
  }

  async function findObject(userId: string, sha256: string, byteSize: number) {
    const result = await pool.query(
      'SELECT * FROM asset_objects WHERE user_id = $1 AND sha256 = $2 AND byte_size = $3 AND status = $4',
      [userId, sha256, byteSize, 'ready'],
    );
    return result.rows[0] ? mapObject(result.rows[0]) : null;
  }

  async function createObject(record: AssetObjectRecord) {
    const result = await pool.query(
      'INSERT INTO asset_objects (id, user_id, storage_key, sha256, byte_size, media_type, status) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, sha256, byte_size) DO UPDATE SET media_type = asset_objects.media_type RETURNING *',
      [record.id, record.userId, record.storageKey, record.sha256, record.byteSize, record.mediaType, record.status],
    );
    return mapObject(result.rows[0]);
  }

  async function createAttachment(input: ThreadScope & { id: string; userId: string; objectId: string; filename: string }) {
    const result = await pool.query(
      'INSERT INTO workflow_attachments (id,user_id,object_id,context_id,route_id,thread_id,stage_key,filename) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, filename, created_at',
      [input.id, input.userId, input.objectId, input.contextId, input.routeId, input.threadId, input.stageKey, input.filename],
    );
    return result.rows[0];
  }

  async function createStagedAttachment(input: {
    id: string;
    userId: string;
    objectId: string;
    filename: string;
  }): Promise<StagedAttachmentRecord> {
    const result = await pool.query(
      'INSERT INTO staged_attachments (id, user_id, object_id, filename) ' +
      "VALUES ($1, $2, $3, $4) RETURNING id, user_id, object_id, filename, status, created_at",
      [input.id, input.userId, input.objectId, input.filename],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      objectId: row.object_id,
      filename: row.filename,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  async function deleteStagedAttachment(userId: string, attachmentId: string) {
    return withTransaction(pool, async (client) => {
      await expireStaleAttachmentClaims(client, userId, [attachmentId], new Date());
      const result = await client.query(
        "DELETE FROM staged_attachments WHERE id = $1 AND user_id = $2 AND status = 'pending' " +
        'AND claimed_command_id IS NULL RETURNING id',
        [attachmentId, userId],
      );
      return result.rowCount === 1;
    });
  }

  async function listThreadAttachments(userId: string, threadId: string) {
    const result = await pool.query(
      "SELECT 'attachment' AS kind, a.id, a.filename, o.media_type, o.byte_size, o.sha256, a.created_at " +
      'FROM workflow_attachments a JOIN asset_objects o ON o.id = a.object_id ' +
      'WHERE a.user_id = $1 AND a.thread_id = $2 ORDER BY a.created_at, a.id',
      [userId, threadId],
    );
    return result.rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      filename: row.filename,
      mediaType: row.media_type,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      createdAt: row.created_at,
    }));
  }

  async function listConversationAttachments(userId: string, conversationId: string) {
    const owned = await pool.query(
      'SELECT t.id FROM workflow_threads t JOIN contexts c ON c.id = t.context_id ' +
      'WHERE t.id = $1 AND c.user_id = $2',
      [conversationId, userId],
    );
    if (!owned.rows[0]) return null;
    return listThreadAttachments(userId, conversationId);
  }

  async function listStageArtifacts(userId: string, routeId: string, stageKey: string) {
    const result = await pool.query(
      "SELECT 'artifact' AS kind, a.id, a.filename, " +
      "COALESCE(o.media_type, 'application/octet-stream') AS media_type, " +
      'COALESCE(o.byte_size, 0) AS byte_size, ' +
      "COALESCE(o.sha256, '') AS sha256, a.created_at " +
      'FROM workflow_routes r JOIN contexts c ON c.id = r.context_id ' +
      'JOIN workflow_checkpoints cp ON cp.id = r.head_checkpoint_id ' +
      "CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cp.snapshot->'artifacts', '[]'::jsonb)) ref " +
      "JOIN workflow_artifacts a ON a.id = (ref->>'id')::uuid " +
      'LEFT JOIN asset_objects o ON o.id = a.object_id ' +
      "WHERE c.user_id = $1 AND r.id = $2 AND ref->>'stage_key' = $3 AND a.status = 'ready' " +
      'ORDER BY a.created_at, a.id',
      [userId, routeId, stageKey],
    );
    return result.rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      filename: row.filename,
      mediaType: row.media_type,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      createdAt: row.created_at,
    }));
  }

  async function getOwnedAsset(userId: string, kind: 'attachment' | 'artifact' | 'archive', id: string) {
    if (kind === 'attachment') {
      const result = await pool.query(
        'SELECT a.filename, o.* FROM (' +
        'SELECT id, user_id, object_id, filename FROM workflow_attachments ' +
        'UNION ALL ' +
        'SELECT id, user_id, object_id, filename FROM staged_attachments' +
        ') a JOIN asset_objects o ON o.id = a.object_id ' +
        "WHERE a.id = $1 AND a.user_id = $2 AND o.status = 'ready' LIMIT 1",
        [id, userId],
      );
      return result.rows[0] ? { filename: result.rows[0].filename, object: mapObject(result.rows[0]) } : null;
    }
    const table = kind === 'artifact' ? 'workflow_artifacts' : 'librechat_archive_attachments';
    const result = await pool.query(
      `SELECT a.filename, o.* FROM ${table} a JOIN asset_objects o ON o.id = a.object_id ` +
      "WHERE a.id = $1 AND a.user_id = $2 AND o.status = 'ready'" +
      (kind === 'artifact' || kind === 'archive' ? " AND a.status = 'ready'" : ''),
      [id, userId],
    );
    return result.rows[0] ? { filename: result.rows[0].filename, object: mapObject(result.rows[0]) } : null;
  }

  async function createArtifact(input: ThreadScope & {
    id: string; userId: string; objectId: string; commandId: string; filename: string;
  }) {
    const result = await pool.query(
      'INSERT INTO workflow_artifacts (id,user_id,object_id,command_id,context_id,route_id,thread_id,stage_key,filename,status) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready') RETURNING id, filename, created_at",
      [input.id, input.userId, input.objectId, input.commandId, input.contextId, input.routeId, input.threadId, input.stageKey, input.filename],
    );
    return result.rows[0];
  }
  async function createFailedArtifact(input: ThreadScope & {
    id: string; userId: string; commandId: string; filename: string; errorCode: string;
  }) {
    const result = await pool.query(
      'INSERT INTO workflow_artifacts (id,user_id,command_id,context_id,route_id,thread_id,stage_key,filename,status,error_code) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'failed',$9) RETURNING id, filename, status, error_code",
      [input.id, input.userId, input.commandId, input.contextId, input.routeId, input.threadId, input.stageKey, input.filename, input.errorCode],
    );
    return result.rows[0];
  }

  return {
    getThreadScope,
    findObject,
    createObject,
    createAttachment,
    createStagedAttachment,
    deleteStagedAttachment,
    listThreadAttachments,
    listConversationAttachments,
    listStageArtifacts,
    getOwnedAsset,
    createArtifact,
    createFailedArtifact,
  };
}

export type AssetRepository = ReturnType<typeof createAssetRepository>;
