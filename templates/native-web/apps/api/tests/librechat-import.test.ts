import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importLibreChat } from '../src/archive/import-librechat.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'librechat-import-'));
  directories.push(directory);
  const body = Buffer.from('legacy attachment');
  await writeFile(join(directory, 'resume.txt'), body);
  const calls: Record<string, any[]> = { conversations: [], messages: [], attachments: [], missing: [], objects: [] };
  const repository = {
    async upsertConversation(input: any) { calls.conversations.push(input); return input.id; },
    async upsertMessage(input: any) { calls.messages.push(input); return { id: input.id, inserted: true }; },
    async upsertAttachment(input: any) { calls.attachments.push(input); return true; },
    async recordMissingAttachment(input: any) { calls.missing.push(input); },
  };
  const assetService = {
    async persistObject(userId: string, contents: Buffer, mediaType: string) {
      calls.objects.push({ userId, contents: contents.toString(), mediaType });
      return { id: 'object-1' };
    },
  };
  const source = { conversations: [{
    conversationId: 'conv-1', title: 'Old discussion', createdAt: '2025-01-01T00:00:00.000Z',
    messages: [{
      messageId: 'msg-1', role: 'user', text: 'hello', createdAt: '2025-01-01T00:00:01.000Z',
      attachments: [{ id: 'file-1', filename: 'resume.txt', path: 'resume.txt', mediaType: 'text/plain', sha256: createHash('sha256').update(body).digest('hex') }],
    }],
  }] };
  return { directory, calls, repository, assetService, source };
}

describe('LibreChat archive import', () => {
  it('preserves source ids, roles, timestamps, and verified attachment bodies', async () => {
    const f = await fixture();
    const report = await importLibreChat({
      userId: 'user-1', source: f.source, attachmentsDirectory: f.directory,
      repository: f.repository as any, assetService: f.assetService as any,
    });
    expect(report).toEqual({ conversations: 1, messages: 1, attachments: 1, skipped: 0, failures: [] });
    expect(f.calls.conversations[0]).toMatchObject({ sourceId: 'conv-1', title: 'Old discussion' });
    expect(f.calls.messages[0]).toMatchObject({ sourceId: 'msg-1', role: 'user', content: 'hello', sequence: 1 });
    expect(f.calls.objects[0]).toEqual({ userId: 'user-1', contents: 'legacy attachment', mediaType: 'text/plain' });
  });

  it('dry-runs without writes and reports missing or mismatched attachments', async () => {
    const f = await fixture();
    f.source.conversations[0]!.messages[0]!.attachments.push({
      id: 'missing', filename: 'missing.txt', path: 'missing.txt', mediaType: 'text/plain', sha256: '0'.repeat(64),
    });
    f.source.conversations[0]!.messages[0]!.attachments[0]!.sha256 = 'f'.repeat(64);
    const report = await importLibreChat({
      userId: 'user-1', source: f.source, attachmentsDirectory: f.directory,
      repository: f.repository as any, assetService: f.assetService as any, dryRun: true,
    });
    expect(report.failures).toEqual([
      { sourceId: 'file-1', code: 'ATTACHMENT_HASH_MISMATCH' },
      { sourceId: 'missing', code: 'ATTACHMENT_MISSING' },
    ]);
    expect(f.calls.conversations).toHaveLength(0);
    expect(f.calls.messages).toHaveLength(0);
    expect(f.calls.objects).toHaveLength(0);
  });
});
