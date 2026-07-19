import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

test('keeps Interrupt controls in normal flow above the sticky composer at desktop and 390px', async () => {
  const styles = await readFile(
    new URL('../templates/native-web/apps/web/src/styles.css', import.meta.url),
    'utf8',
  );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.setContent(`<!doctype html><html><head><style>${styles}</style><style>
        body { margin: 0; }
        .app-shell.conversation-first-shell { display: block; height: 520px; }
        .conversation-axis { width: 100%; height: 520px; padding-block-start: 0 !important; padding-inline: 0 !important; overflow-y: auto; }
        .conversation { width: min(860px, 100%); margin: 0 auto; }
        .message-timeline { height: 760px; min-height: 760px; }
      </style></head><body>
        <div class="app-shell conversation-first-shell"><main class="conversation-axis">
          <section class="conversation">
            <div class="message-timeline"></div>
            <form class="interrupt-panel">
              <strong>需要确认</strong>
              <label>Interrupt 回复<textarea>继续</textarea></label>
              <button type="button">继续 Workflow</button>
            </form>
            <form class="message-composer">
              <label>Workflow Input<textarea disabled></textarea></label>
              <div class="composer-footer"><button type="button" disabled>发送 Workflow Input</button></div>
            </form>
          </section>
        </main></div>
      </body></html>`);
      await page.locator('.conversation-axis').evaluate((axis) => {
        axis.scrollTop = axis.scrollHeight;
      });
      const continueButton = page.getByRole('button', { name: '继续 Workflow' });
      await continueButton.scrollIntoViewIfNeeded();
      const contract = await continueButton.evaluate((button) => {
        const interrupt = button.closest('.interrupt-panel');
        const composer = document.querySelector('.message-composer');
        const bounds = button.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return {
          interruptPosition: interrupt ? getComputedStyle(interrupt).position : '',
          composerPosition: composer ? getComputedStyle(composer).position : '',
          composerBottom: composer ? getComputedStyle(composer).bottom : '',
          buttonHit: hit === button || button.contains(hit),
          hitElement: hit ? `${hit.tagName}.${hit.className}` : 'none',
          buttonBounds: { top: bounds.top, bottom: bounds.bottom },
          composerBounds: composer ? (() => {
            const composerRect = composer.getBoundingClientRect();
            return { top: composerRect.top, bottom: composerRect.bottom };
          })() : null,
        };
      });

      assert.equal(contract.interruptPosition, 'static', `${width}px Interrupt must remain in normal flow`);
      assert.equal(contract.composerPosition, 'sticky', `${width}px composer must remain sticky`);
      assert.equal(contract.composerBottom, '0px', `${width}px composer must retain safe bottom inset`);
      assert.equal(contract.buttonHit, true, `${width}px button hit by ${contract.hitElement}; ` +
        `button=${JSON.stringify(contract.buttonBounds)} composer=${JSON.stringify(contract.composerBounds)}`);
      await continueButton.click({ timeout: 1_000 });
    }
  } finally {
    await browser.close();
  }
});
