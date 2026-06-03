import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { describeCheckupScreenshot } from '../src/engine/checkup-vlm'

describe('describeCheckupScreenshot', () => {
  const origFetch = globalThis.fetch

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.stubGlobal('fetch', origFetch)
    vi.restoreAllMocks()
  })

  it('returns empty when screenshot missing', async () => {
    const r = await describeCheckupScreenshot({ screenshotB64: '' })
    expect(r.vlm_backend).toBe('none')
    expect(r.visual_summary).toBe('')
  })

  it('uses PolarPrivate L101 when proxy succeeds', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '按钮不可点击。严重度：高' } }],
        }),
        { status: 200 },
      ),
    )

    const r = await describeCheckupScreenshot({
      screenshotB64: 'iVBORw0KGgo=',
      userText: '登录失败',
      pageUrl: 'http://localhost/app',
    })

    expect(r.vlm_backend).toBe('polarprivate')
    expect(r.severity).toBe('high')
    expect(r.visual_summary).toContain('严重度')
    const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body))
    expect(body.model).toBe('L101')
  })

  it('falls back to Ollama when PolarPrivate fails', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch
      .mockRejectedValueOnce(new Error('proxy down'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: { content: '布局错位。严重度：中' } }),
          { status: 200 },
        ),
      )

    const r = await describeCheckupScreenshot({
      screenshotB64: 'abc123',
      userText: '排版乱了',
    })

    expect(r.vlm_backend).toBe('ollama')
    expect(r.severity).toBe('medium')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
