import { test, expect } from '@playwright/test'

/**
 * Visual baselines for the claude-code workflow canvas — both UI themes (R11 视觉门禁).
 * Workflow loads via localStorage last-session (registryId), not URL params.
 *
 * 这两条测试跑在 `npm run qa` 内（scripts/run-qa.mjs 的 test:canvas-baseline 步）：
 * 视觉回归由流水线裁决；`--update-snapshots` 重录基线是有意设计变更的唯一人工确认点。
 */
const THEMES = ['light', 'hermes'] as const

for (const theme of THEMES) {
  test.describe(`canvas visual baseline — ${theme}`, () => {
    test(`claude-code registry workflow renders stable wire routing (${theme})`, async ({ page }) => {
      await page.addInitScript((themeName) => {
        localStorage.clear()
        localStorage.setItem('polarui-theme', themeName)
        localStorage.setItem(
          'polarui_last_session_v1',
          JSON.stringify({ viewMode: 'workflow', registryId: 'claude-code' }),
        )
      }, theme)

      await page.goto('/')

      await expect(page.locator('.app-footer')).toContainText('组件: 26', { timeout: 30_000 })
      await expect(page.locator('.app-footer')).toContainText('连线:')

      const canvas = page.locator('.canvas-primary canvas')
      await expect(canvas).toBeVisible()

      // Auto-layout + wire routing settle after registry fetch
      await page.waitForTimeout(800)

      await expect(page.locator('.canvas-primary')).toHaveScreenshot(`claude-code-canvas-${theme}.png`)
    })
  })
}
