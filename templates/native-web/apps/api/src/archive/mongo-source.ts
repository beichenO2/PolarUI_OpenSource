import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { libreChatExportSchema, type LibreChatExport } from './import-librechat.js';

const mongoEnvelopeSchema = z.object({ conversations: z.array(z.unknown()), messages: z.array(z.unknown()) }).strict();

const readOnlyScript = String.raw`
const database = connect(process.env.POLAR_LIBRECHAT_MONGO_URI);
const sourceUser = process.env.POLAR_LIBRECHAT_SOURCE_USER || '';
const owned = sourceUser ? { $or: [{ user: sourceUser }, { userId: sourceUser }] } : {};
const conversations = database.getCollection('conversations').find(owned).toArray();
const conversationIds = conversations.flatMap((item) => [item.conversationId, item._id].filter(Boolean).map(String));
const messages = database.getCollection('messages').find({ $or: [
  { conversationId: { $in: conversationIds } },
  { conversation_id: { $in: conversationIds } }
] }).sort({ createdAt: 1, created_at: 1 }).toArray();
print(JSON.stringify({ conversations, messages }));
`;

function timestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function mapMongoEnvelope(raw: unknown): LibreChatExport {
  const envelope = mongoEnvelopeSchema.parse(raw);
  const messages = envelope.messages as Array<Record<string, any>>;
  return libreChatExportSchema.parse({ conversations: (envelope.conversations as Array<Record<string, any>>).map((conversation) => {
    const conversationId = String(conversation.conversationId ?? conversation._id);
    return {
      conversationId,
      title: String(conversation.title ?? 'Imported conversation'),
      ...(timestamp(conversation.createdAt ?? conversation.created_at) ? { createdAt: timestamp(conversation.createdAt ?? conversation.created_at) } : {}),
      ...(timestamp(conversation.updatedAt ?? conversation.updated_at) ? { updatedAt: timestamp(conversation.updatedAt ?? conversation.updated_at) } : {}),
      messages: messages.filter((message) => String(message.conversationId ?? message.conversation_id) === conversationId).map((message) => ({
        messageId: String(message.messageId ?? message.message_id ?? message._id),
        role: ['user', 'assistant', 'system', 'tool'].includes(message.role)
          ? message.role
          : message.sender === 'User' || message.isCreatedByUser ? 'user' : 'assistant',
        text: String(message.text ?? message.content ?? ''),
        ...(timestamp(message.createdAt ?? message.created_at) ? { createdAt: timestamp(message.createdAt ?? message.created_at) } : {}),
        attachments: (message.files ?? message.attachments ?? []).map((file: Record<string, any>) => ({
          id: String(file.file_id ?? file.id ?? file._id),
          filename: String(file.filename ?? file.name ?? 'attachment.bin'),
          path: String(file.filepath ?? file.path),
          ...(file.sha256 ? { sha256: String(file.sha256) } : {}),
          mediaType: String(file.type ?? file.mimeType ?? 'application/octet-stream'),
        })),
      })),
    };
  }) });
}

export function readLibreChatMongo(options: {
  uri: string; sourceUser?: string; spawn?: typeof spawnSync;
}): LibreChatExport {
  const spawn = options.spawn ?? spawnSync;
  const result = spawn('mongosh', ['--quiet', '--nodb', '--eval', readOnlyScript], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, POLAR_LIBRECHAT_MONGO_URI: options.uri, POLAR_LIBRECHAT_SOURCE_USER: options.sourceUser ?? '' },
  });
  if (result.error || result.status !== 0) throw new Error('LIBRECHAT_MONGO_READ_FAILED');
  const line = String(result.stdout).trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error('LIBRECHAT_MONGO_EMPTY');
  return mapMongoEnvelope(JSON.parse(line));
}
