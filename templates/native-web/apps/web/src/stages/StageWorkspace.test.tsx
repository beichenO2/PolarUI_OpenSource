import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StageWorkspace } from './StageWorkspace';

afterEach(() => vi.restoreAllMocks());
describe('fixed stage component registry', () => {
  it.each([
    ['generic_chat', '当前任务'],
    ['structured_form', '信息整理'],
    ['card_selection', '方案选择'],
    ['document_workspace', '工作文档'],
  ] as const)('renders %s without a recursive layout interpreter', async (componentKey, title) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(
      { artifacts: [] },
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { unmount } = render(<StageWorkspace componentKey={componentKey} routeId="route-1" stageKey="discover" />);
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(document.querySelector('[data-component-key]')).toHaveAttribute('data-component-key', componentKey);
    expect(screen.queryByLabelText('添加附件')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('线程');
    unmount();
  });

  it('refreshes accepted stage artifacts after a command revision', async () => {
    let revision = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      return new Response(JSON.stringify({ artifacts: revision === 0 ? [] : [{
        kind: 'artifact', id: 'artifact-1', filename: 'workflow-report.txt',
        mediaType: 'text/plain', byteSize: 11, sha256: 'abc', createdAt: '2026-07-16T00:00:00.000Z',
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const rendered = render(<StageWorkspace componentKey="generic_chat" routeId="route-1" stageKey="discover" revision={revision} />);
    await screen.findByText('还没有正式成果。');

    revision = 1;
    rendered.rerender(<StageWorkspace componentKey="generic_chat" routeId="route-1" stageKey="discover" revision={revision} />);

    expect(await screen.findByRole('link', { name: /workflow-report\.txt/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
