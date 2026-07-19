import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AttachmentPanel } from './AttachmentPanel';
import type { StagedAttachment } from './api';

afterEach(() => vi.restoreAllMocks());

function response(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? undefined : { 'content-type': 'application/json' },
  });
}

const pending: StagedAttachment = {
  id: 'attachment-1', filename: 'notes.txt', mediaType: 'text/plain',
  byteSize: 5, sha256: 'abc', status: 'pending', conversationId: null,
  createdAt: '2026-07-17T00:00:00.000Z',
};

const laterPending: StagedAttachment = {
  ...pending,
  id: 'attachment-2',
  filename: 'later.txt',
};

const newestPending: StagedAttachment = {
  ...pending,
  id: 'attachment-3',
  filename: 'newest.txt',
};

type StagedUpdater = (current: StagedAttachment[]) => StagedAttachment[];

function createDraftStore(entries: Array<[string, StagedAttachment[]]>) {
  const drafts = new Map(entries);
  const onChange = vi.fn((ownerKey: string, update: StagedUpdater) => {
    drafts.set(ownerKey, update(drafts.get(ownerKey) ?? []));
  });
  return { drafts, onChange };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function resolveFetch(request: ReturnType<typeof deferred<Response>>, value: Response) {
  await act(async () => {
    request.resolve(value);
    await request.promise;
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function rejectFetch(request: ReturnType<typeof deferred<Response>>, error: Error) {
  await act(async () => {
    request.reject(error);
    await request.promise.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
  });
}

it('uploads a controlled staged attachment before a Conversation exists', async () => {
  const user = userEvent.setup();
  const store = createDraftStore([['draft:default', []]]);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ attachment: pending }, 201));

  render(<AttachmentPanel staged={store.drafts.get('draft:default')} onChange={store.onChange} />);

  await user.upload(screen.getByLabelText('添加附件'), new File(['hello'], 'notes.txt', { type: 'text/plain' }));

  await waitFor(() => expect(store.drafts.get('draft:default')).toEqual([pending]));
  expect(fetch).toHaveBeenCalledWith('/api/attachments/staged', expect.objectContaining({ method: 'POST' }));
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/api/conversations/'))).toBe(false);
});

it('clears the file input without reporting failure after a deferred upload succeeds', async () => {
  const user = userEvent.setup();
  const request = deferred<Response>();
  const store = createDraftStore([['draft:default', []]]);
  vi.spyOn(globalThis, 'fetch').mockReturnValue(request.promise);
  render(<AttachmentPanel staged={[]} onChange={store.onChange} />);
  const input = screen.getByLabelText('添加附件') as HTMLInputElement;

  await user.upload(input, new File(['hello'], 'notes.txt', { type: 'text/plain' }));
  await resolveFetch(request, response({ attachment: pending }, 201));

  expect(store.drafts.get('draft:default')).toEqual([pending]);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(input.value).toBe('');
});

it('keeps staged IDs visible until the owner changes them and lists adopted items after success', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response({ attachments: [] }))
    .mockResolvedValueOnce(response({ attachments: [{
    kind: 'attachment', id: 'adopted-1', filename: 'adopted.txt',
    mediaType: 'text/plain', byteSize: 7, sha256: 'def', createdAt: '2026-07-17T00:01:00.000Z',
  }] }));
  const store = createDraftStore([['conversation:conversation-1', [pending]]]);
  const view = render(<AttachmentPanel staged={[pending]} onChange={store.onChange} conversationId="conversation-1" />);

  expect(screen.getByText('notes.txt')).toBeInTheDocument();
  expect(screen.getByText('待发送')).toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

  // A failed attempt leaves the controlled attachment IDs untouched.
  view.rerender(<AttachmentPanel staged={[pending]} onChange={store.onChange} conversationId="conversation-1" />);
  expect(screen.getByText('notes.txt')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);

  // The successful owner clears staged IDs; the same Conversation then reloads adopted items.
  view.rerender(<AttachmentPanel staged={[]} onChange={store.onChange} conversationId="conversation-1" />);

  expect(await screen.findByRole('link', { name: /adopted\.txt/ })).toBeInTheDocument();
  expect(store.onChange).not.toHaveBeenCalled();
});

it('removes a staged attachment only after the owned delete succeeds', async () => {
  const user = userEvent.setup();
  const store = createDraftStore([['draft:default', [pending]]]);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(null, 204));

  render(<AttachmentPanel staged={[pending]} onChange={store.onChange} />);

  await user.click(screen.getByRole('button', { name: '移除 notes.txt' }));

  await waitFor(() => expect(store.drafts.get('draft:default')).toEqual([]));
  expect(fetch).toHaveBeenCalledWith('/api/attachments/staged/attachment-1', expect.objectContaining({ method: 'DELETE' }));
});

it('ignores a slower attachment list response from a previously selected Conversation', async () => {
  const firstRequest = deferred<Response>();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = String(input);
    if (url.includes('conversation-a')) return firstRequest.promise;
    if (url.includes('conversation-b')) return Promise.resolve(response({ attachments: [{
      kind: 'attachment', id: 'asset-b', filename: 'conversation-b.txt', mediaType: 'text/plain',
      byteSize: 8, sha256: 'b'.repeat(64), createdAt: '2026-07-17T00:02:00.000Z',
    }] }));
    throw new Error(`unexpected request: ${url}`);
  });
  const view = render(<AttachmentPanel conversationId="conversation-a" />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

  view.rerender(<AttachmentPanel conversationId="conversation-b" />);
  expect(await screen.findByText('conversation-b.txt')).toBeInTheDocument();

  await resolveFetch(firstRequest, response({ attachments: [{
    kind: 'attachment', id: 'asset-a', filename: 'conversation-a.txt', mediaType: 'text/plain',
    byteSize: 7, sha256: 'a'.repeat(64), createdAt: '2026-07-17T00:01:00.000Z',
  }] }));

  expect(screen.queryByText('conversation-a.txt')).not.toBeInTheDocument();
  expect(screen.getByText('conversation-b.txt')).toBeInTheDocument();
});

it('does not restore a pending list response after the Conversation is cleared', async () => {
  const request = deferred<Response>();
  const fetch = vi.spyOn(globalThis, 'fetch').mockReturnValue(request.promise);
  const view = render(<AttachmentPanel conversationId="conversation-a" />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

  view.rerender(<AttachmentPanel />);
  await resolveFetch(request, response({ attachments: [{
    kind: 'attachment', id: 'asset-a', filename: 'conversation-a.txt', mediaType: 'text/plain',
    byteSize: 7, sha256: 'a'.repeat(64), createdAt: '2026-07-17T00:01:00.000Z',
  }] }));

  expect(screen.queryByText('conversation-a.txt')).not.toBeInTheDocument();
  expect(screen.getByText('还没有附件。')).toBeInTheDocument();
});

it('merges a completed upload with the latest controlled staged attachments', async () => {
  const user = userEvent.setup();
  const request = deferred<Response>();
  const store = createDraftStore([['draft:default', [pending]]]);
  vi.spyOn(globalThis, 'fetch').mockReturnValue(request.promise);
  const view = render(<AttachmentPanel staged={[pending]} onChange={store.onChange} />);

  await user.upload(screen.getByLabelText('添加附件'), new File(['new'], 'newest.txt', { type: 'text/plain' }));
  store.drafts.set('draft:default', [pending, laterPending]);
  view.rerender(<AttachmentPanel staged={[pending, laterPending]} onChange={store.onChange} />);
  await resolveFetch(request, response({ attachment: newestPending }, 201));

  expect(store.drafts.get('draft:default')).toEqual([pending, laterPending, newestPending]);
});

it('removes from the latest controlled staged attachments after delete completes', async () => {
  const user = userEvent.setup();
  const request = deferred<Response>();
  const store = createDraftStore([['draft:default', [pending, laterPending]]]);
  vi.spyOn(globalThis, 'fetch').mockReturnValue(request.promise);
  const view = render(<AttachmentPanel staged={[pending, laterPending]} onChange={store.onChange} />);

  await user.click(screen.getByRole('button', { name: '移除 notes.txt' }));
  store.drafts.set('draft:default', [laterPending, newestPending]);
  view.rerender(<AttachmentPanel staged={[laterPending, newestPending]} onChange={store.onChange} />);
  await resolveFetch(request, response(null, 204));

  expect(store.drafts.get('draft:default')).toEqual([laterPending, newestPending]);
});

it('finishes an upload against its starting draft owner after switching Conversations', async () => {
  const user = userEvent.setup();
  const request = deferred<Response>();
  const store = createDraftStore([
    ['conversation:conversation-a', [pending]],
    ['conversation:conversation-b', [newestPending]],
  ]);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    if (init?.method === 'POST') return request.promise;
    return Promise.resolve(response({ attachments: [] }));
  });
  const view = render(
    <AttachmentPanel staged={[pending]} onChange={store.onChange} conversationId="conversation-a" />,
  );
  await waitFor(() => expect(fetch).toHaveBeenCalled());

  await user.upload(screen.getByLabelText('添加附件'), new File(['new'], 'newest.txt', { type: 'text/plain' }));
  store.drafts.set('conversation:conversation-a', [pending, laterPending]);
  view.rerender(
    <AttachmentPanel staged={[newestPending]} onChange={store.onChange} conversationId="conversation-b" />,
  );

  // The owning command can clear A while it is offscreen; completion must use that latest state.
  store.drafts.set('conversation:conversation-a', [laterPending]);

  expect(screen.getByLabelText('添加附件')).toBeEnabled();
  await resolveFetch(request, response({ attachment: newestPending }, 201));

  expect(store.drafts.get('conversation:conversation-a')).toEqual([laterPending, newestPending]);
  expect(store.drafts.get('conversation:conversation-b')).toEqual([newestPending]);
});

it('finishes a delete against its starting draft owner after switching Conversations', async () => {
  const user = userEvent.setup();
  const request = deferred<Response>();
  const store = createDraftStore([
    ['conversation:conversation-a', [pending, laterPending]],
    ['conversation:conversation-b', [newestPending]],
  ]);
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    if (init?.method === 'DELETE') return request.promise;
    return Promise.resolve(response({ attachments: [] }));
  });
  const view = render(
    <AttachmentPanel staged={[pending, laterPending]} onChange={store.onChange} conversationId="conversation-a" />,
  );

  await user.click(screen.getByRole('button', { name: '移除 notes.txt' }));
  view.rerender(
    <AttachmentPanel staged={[newestPending]} onChange={store.onChange} conversationId="conversation-b" />,
  );
  store.drafts.set('conversation:conversation-a', [pending, newestPending]);
  await resolveFetch(request, response(null, 204));

  expect(store.drafts.get('conversation:conversation-a')).toEqual([newestPending]);
  expect(store.drafts.get('conversation:conversation-b')).toEqual([newestPending]);
});

it('does not leak an old draft mutation error or busy state into a new Conversation', async () => {
  const user = userEvent.setup();
  const request = deferred<Response>();
  const store = createDraftStore([
    ['conversation:conversation-a', [pending]],
    ['conversation:conversation-b', [laterPending]],
  ]);
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    if (init?.method === 'DELETE') return request.promise;
    return Promise.resolve(response({ attachments: [] }));
  });
  const view = render(
    <AttachmentPanel staged={[pending]} onChange={store.onChange} conversationId="conversation-a" />,
  );

  await user.click(screen.getByRole('button', { name: '移除 notes.txt' }));
  view.rerender(
    <AttachmentPanel staged={[laterPending]} onChange={store.onChange} conversationId="conversation-b" />,
  );

  expect(screen.getByRole('button', { name: '移除 later.txt' })).toBeEnabled();
  await rejectFetch(request, new Error('delete failed'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(store.onChange).not.toHaveBeenCalled();
});

it('keeps one owner record when an inline callback changes during the same draft operation', async () => {
  const user = userEvent.setup();
  const request = deferred<Response>();
  const store = createDraftStore([['draft:default', [pending]]]);
  vi.spyOn(globalThis, 'fetch').mockReturnValue(request.promise);
  const view = render(
    <AttachmentPanel
      staged={[pending]}
      onChange={(ownerKey, update) => store.onChange(ownerKey, update)}
    />,
  );

  await user.upload(screen.getByLabelText('添加附件'), new File(['new'], 'newest.txt', { type: 'text/plain' }));
  store.drafts.set('draft:default', [pending, laterPending]);
  view.rerender(
    <AttachmentPanel
      staged={[pending, laterPending]}
      onChange={(ownerKey, update) => store.onChange(ownerKey, update)}
    />,
  );
  await resolveFetch(request, response({ attachment: newestPending }, 201));

  expect(store.drafts.get('draft:default')).toEqual([pending, laterPending, newestPending]);
});

it('keeps two zero-Conversation drafts isolated by draftKey with one stable callback', async () => {
  const user = userEvent.setup();
  const request = deferred<Response>();
  const store = createDraftStore([
    ['draft:draft-a', [pending]],
    ['draft:draft-b', [laterPending]],
  ]);
  vi.spyOn(globalThis, 'fetch').mockReturnValue(request.promise);
  const view = render(
    <AttachmentPanel
      draftKey="draft-a"
      staged={store.drafts.get('draft:draft-a')}
      onChange={store.onChange}
    />,
  );

  await user.upload(screen.getByLabelText('添加附件'), new File(['new'], 'newest.txt', { type: 'text/plain' }));
  view.rerender(
    <AttachmentPanel
      draftKey="draft-b"
      staged={store.drafts.get('draft:draft-b')}
      onChange={store.onChange}
    />,
  );
  store.drafts.set('draft:draft-a', []);

  expect(screen.getByLabelText('添加附件')).toBeEnabled();
  await resolveFetch(request, response({ attachment: newestPending }, 201));
  expect(store.drafts.get('draft:draft-a')).toEqual([newestPending]);
  expect(store.drafts.get('draft:draft-b')).toEqual([laterPending]);
});

it('keeps uncontrolled deferred uploads isolated per Thread owner', async () => {
  const user = userEvent.setup();
  const firstUpload = deferred<Response>();
  let uploadCount = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    if (init?.method === 'POST') {
      uploadCount += 1;
      return uploadCount === 1
        ? firstUpload.promise
        : Promise.resolve(response({ attachment: laterPending }, 201));
    }
    return Promise.resolve(response({ attachments: [] }));
  });
  const view = render(<AttachmentPanel threadId="thread-a" />);

  await user.upload(screen.getByLabelText('添加附件'), new File(['a'], 'newest.txt', { type: 'text/plain' }));
  view.rerender(<AttachmentPanel threadId="thread-b" />);
  expect(screen.queryByText('newest.txt')).not.toBeInTheDocument();

  await resolveFetch(firstUpload, response({ attachment: newestPending }, 201));
  expect(screen.queryByText('newest.txt')).not.toBeInTheDocument();
  expect(screen.getByText('还没有附件。')).toBeInTheDocument();

  await user.upload(screen.getByLabelText('添加附件'), new File(['b'], 'later.txt', { type: 'text/plain' }));
  expect(await screen.findByText('later.txt')).toBeInTheDocument();
  expect(screen.queryByText('newest.txt')).not.toBeInTheDocument();

  view.rerender(<AttachmentPanel threadId="thread-a" />);
  expect(screen.getByText('newest.txt')).toBeInTheDocument();
  expect(screen.queryByText('later.txt')).not.toBeInTheDocument();
});
