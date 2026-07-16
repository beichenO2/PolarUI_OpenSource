import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AttachmentPanel } from './AttachmentPanel';

afterEach(() => vi.restoreAllMocks());

it('renders only discussion attachments and keeps upload inside the discussion surface', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ attachments: [{
    kind: 'attachment', id: 'attachment-1', filename: 'notes.txt',
    mediaType: 'text/plain', byteSize: 5, sha256: 'abc', createdAt: '2026-07-17T00:00:00.000Z',
  }] }), { status: 200, headers: { 'content-type': 'application/json' } }));

  render(<AttachmentPanel threadId="thread-1" />);

  expect(await screen.findByRole('link', { name: /notes\.txt/ })).toBeInTheDocument();
  expect(screen.getByLabelText('添加附件')).toBeInTheDocument();
  expect(screen.queryByText('Workflow 产物')).not.toBeInTheDocument();
});
