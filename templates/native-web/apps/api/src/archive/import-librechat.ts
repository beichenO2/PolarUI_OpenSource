import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AssetService } from '../assets/service.js';
import type { ArchiveRepository } from './repository.js';

const attachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1).max(255),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  mediaType: z.string().min(3).max(200).default('application/octet-stream'),
}).strict();
const messageSchema = z.object({
  messageId: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  text: z.string(),
  createdAt: z.string().datetime().optional(),
  attachments: z.array(attachmentSchema).default([]),
}).strict();
const conversationSchema = z.object({
  conversationId: z.string().min(1),
  title: z.string().min(1).max(300),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  messages: z.array(messageSchema),
}).strict();
export const libreChatExportSchema = z.object({ conversations: z.array(conversationSchema) }).strict();
export type LibreChatExport = z.infer<typeof libreChatExportSchema>;

function date(value?: string) { return value ? new Date(value) : null; }

export async function importLibreChat(options: {
  userId: string;
  source: unknown;
  attachmentsDirectory: string;
  repository: ArchiveRepository;
  assetService: AssetService;
  dryRun?: boolean;
}) {
  const source = libreChatExportSchema.parse(options.source);
  const report = { conversations: 0, messages: 0, attachments: 0, skipped: 0, failures: [] as Array<{ sourceId: string; code: string }> };
  for (const conversation of source.conversations) {
    report.conversations += 1;
    if (options.dryRun) {
      report.messages += conversation.messages.length;
    }
    const conversationId = options.dryRun ? randomUUID() : await options.repository.upsertConversation({
      id: randomUUID(), userId: options.userId, sourceId: conversation.conversationId,
      title: conversation.title, createdAt: date(conversation.createdAt), updatedAt: date(conversation.updatedAt),
    });
    for (const [index, message] of conversation.messages.entries()) {
      let messageId: string = randomUUID();
      if (!options.dryRun) {
        const storedMessage = await options.repository.upsertMessage({
          id: randomUUID(), conversationId, userId: options.userId, sourceId: message.messageId,
          role: message.role, content: message.text, createdAt: date(message.createdAt), sequence: index + 1,
        });
        messageId = storedMessage.id;
        report[storedMessage.inserted ? 'messages' : 'skipped'] += 1;
      }
      for (const attachment of message.attachments) {
        const lexicalRoot = resolve(options.attachmentsDirectory);
        const path = resolve(lexicalRoot, attachment.path);
        if (path !== lexicalRoot && !path.startsWith(lexicalRoot + '/')) {
          report.failures.push({ sourceId: attachment.id, code: 'INVALID_ATTACHMENT_PATH' });
          continue;
        }
        let body: Buffer;
        try {
          const [root, resolvedPath] = await Promise.all([realpath(lexicalRoot), realpath(path)]);
          if (resolvedPath !== root && !resolvedPath.startsWith(root + '/')) throw new Error('outside root');
          body = await readFile(resolvedPath);
        } catch {
          report.failures.push({ sourceId: attachment.id, code: 'ATTACHMENT_MISSING' });
          if (!options.dryRun) await options.repository.recordMissingAttachment({
            id: randomUUID(), conversationId, messageId, userId: options.userId, sourceId: attachment.id,
            filename: attachment.filename, expectedSha256: attachment.sha256 ?? null, code: 'ATTACHMENT_MISSING',
          });
          continue;
        }
        const hash = createHash('sha256').update(body).digest('hex');
        if (attachment.sha256 && attachment.sha256 !== hash) {
          report.failures.push({ sourceId: attachment.id, code: 'ATTACHMENT_HASH_MISMATCH' });
          if (!options.dryRun) await options.repository.recordMissingAttachment({
            id: randomUUID(), conversationId, messageId, userId: options.userId, sourceId: attachment.id,
            filename: attachment.filename, expectedSha256: attachment.sha256, code: 'ATTACHMENT_HASH_MISMATCH',
          });
          continue;
        }
        if (!options.dryRun) {
          const object = await options.assetService.persistObject(options.userId, body, attachment.mediaType);
          const inserted = await options.repository.upsertAttachment({
            id: randomUUID(), conversationId, messageId, userId: options.userId, objectId: object.id,
            sourceId: attachment.id, filename: attachment.filename, expectedSha256: attachment.sha256 ?? hash,
          });
          report[inserted ? 'attachments' : 'skipped'] += 1;
        } else {
          report.attachments += 1;
        }
      }
    }
  }
  return report;
}
