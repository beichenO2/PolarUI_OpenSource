import type { DatabasePool } from '../db/pool.js';

export function createArchiveRepository(pool: DatabasePool) {
  async function upsertConversation(input: {
    id: string; userId: string; sourceId: string; title: string; createdAt: Date | null; updatedAt: Date | null;
  }) {
    const result = await pool.query(
      'INSERT INTO librechat_archive_conversations (id,user_id,source_conversation_id,title,source_created_at,source_updated_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id,source_conversation_id) DO NOTHING RETURNING id',
      [input.id, input.userId, input.sourceId, input.title, input.createdAt, input.updatedAt],
    );
    if (result.rows[0]) return result.rows[0].id as string;
    const existing = await pool.query(
      'SELECT id FROM librechat_archive_conversations WHERE user_id=$1 AND source_conversation_id=$2',
      [input.userId, input.sourceId],
    );
    return existing.rows[0].id as string;
  }
  async function upsertMessage(input: {
    id: string; conversationId: string; userId: string; sourceId: string; role: string; content: string; createdAt: Date | null; sequence: number;
  }) {
    const result = await pool.query(
      'INSERT INTO librechat_archive_messages (id,conversation_id,user_id,source_message_id,role,content,source_created_at,sequence) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id,source_message_id) DO NOTHING RETURNING id',
      [input.id, input.conversationId, input.userId, input.sourceId, input.role, input.content, input.createdAt, input.sequence],
    );
    if (result.rows[0]) return { id: result.rows[0].id as string, inserted: true };
    const existing = await pool.query('SELECT id FROM librechat_archive_messages WHERE user_id=$1 AND source_message_id=$2', [input.userId, input.sourceId]);
    return { id: existing.rows[0].id as string, inserted: false };
  }
  async function upsertAttachment(input: {
    id: string; conversationId: string; messageId: string; userId: string; objectId: string; sourceId: string; filename: string; expectedSha256: string;
  }) {
    const result = await pool.query(
      'INSERT INTO librechat_archive_attachments (id,conversation_id,message_id,user_id,object_id,source_attachment_id,filename,expected_sha256,status) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready') ON CONFLICT (user_id,source_attachment_id) DO NOTHING RETURNING id",
      [input.id, input.conversationId, input.messageId, input.userId, input.objectId, input.sourceId, input.filename, input.expectedSha256],
    );
    return result.rowCount === 1;
  }
  async function recordMissingAttachment(input: {
    id: string; conversationId: string; messageId: string; userId: string; sourceId: string; filename: string; expectedSha256: string | null; code: string;
  }) {
    const status = input.code === 'ATTACHMENT_HASH_MISMATCH' ? 'hash_mismatch' : 'missing';
    await pool.query(
      'INSERT INTO librechat_archive_attachments (id,conversation_id,message_id,user_id,source_attachment_id,filename,expected_sha256,status,error_code) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (user_id,source_attachment_id) DO NOTHING',
      [input.id, input.conversationId, input.messageId, input.userId, input.sourceId, input.filename, input.expectedSha256, status, input.code],
    );
  }
  async function list(userId: string) {
    const result = await pool.query(
      'SELECT c.*, COUNT(m.id)::int AS message_count FROM librechat_archive_conversations c ' +
      'LEFT JOIN librechat_archive_messages m ON m.conversation_id=c.id WHERE c.user_id=$1 ' +
      'GROUP BY c.id ORDER BY c.source_updated_at DESC NULLS LAST,c.id', [userId],
    );
    return result.rows.map((row) => ({
      id: row.id, sourceConversationId: row.source_conversation_id, title: row.title,
      createdAt: row.source_created_at, updatedAt: row.source_updated_at, messageCount: row.message_count, readOnly: true,
    }));
  }
  async function detail(userId: string, conversationId: string) {
    const conversation = await pool.query(
      'SELECT * FROM librechat_archive_conversations WHERE id=$1 AND user_id=$2', [conversationId, userId],
    );
    if (!conversation.rows[0]) return null;
    const [messages, attachments] = await Promise.all([
      pool.query('SELECT id,source_message_id,role,content,source_created_at,sequence FROM librechat_archive_messages WHERE conversation_id=$1 ORDER BY sequence', [conversationId]),
      pool.query('SELECT id,source_attachment_id,filename,status,error_code FROM librechat_archive_attachments WHERE conversation_id=$1 ORDER BY imported_at,id', [conversationId]),
    ]);
    return { conversation: { id: conversationId, title: conversation.rows[0].title, readOnly: true }, messages: messages.rows, attachments: attachments.rows };
  }
  async function findUser(user: string) {
    const result = await pool.query('SELECT id FROM users WHERE id::text=$1 OR email_normalized=lower($1) OR username_normalized=lower($1) LIMIT 1', [user]);
    return result.rows[0]?.id as string | undefined;
  }
  return { upsertConversation, upsertMessage, upsertAttachment, recordMissingAttachment, list, detail, findUser };
}
export type ArchiveRepository = ReturnType<typeof createArchiveRepository>;
