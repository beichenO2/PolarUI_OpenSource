import { describe, expect, it, vi } from 'vitest';
import { readLibreChatMongo } from '../src/archive/mongo-source.js';

describe('read-only LibreChat Mongo source', () => {
  it('keeps credentials out of arguments and maps common LibreChat fields', () => {
    const spawn = vi.fn((_command, args, options) => ({
      status: 0, stdout: JSON.stringify({
        conversations: [{ _id: 'conv-1', title: 'Legacy', user: 'legacy-user', createdAt: '2025-01-01T00:00:00Z' }],
        messages: [{ _id: 'msg-1', conversationId: 'conv-1', sender: 'User', text: 'hello', createdAt: '2025-01-01T00:00:01Z', files: [{ id: 'file-1', name: 'note.txt', path: 'note.txt', type: 'text/plain' }] }],
      }) + '\n', stderr: '', error: undefined,
    })) as any;
    const source = readLibreChatMongo({ uri: 'mongodb://user:secret@mongo/librechat', sourceUser: 'legacy-user', spawn });
    expect(source.conversations[0]).toMatchObject({ conversationId: 'conv-1', title: 'Legacy', messages: [{ messageId: 'msg-1', role: 'user', text: 'hello' }] });
    const [, args, options] = spawn.mock.calls[0]!;
    expect(args.join(' ')).not.toContain('secret');
    expect(options.env.POLAR_LIBRECHAT_MONGO_URI).toContain('secret');
    expect(args).toContain('--nodb');
  });
});
