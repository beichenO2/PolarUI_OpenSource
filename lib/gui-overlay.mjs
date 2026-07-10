/**
 * Unified executor overlay — headless (Node) + GUI (browser).
 * Browser path delegates to gui-overlay-browser.mjs (dist/overlay copy).
 */

/**
 * @param {Function} registerExecutor
 * @param {{ browser?: boolean }} [opts]
 */
export async function registerGuiOverlays(registerExecutor, { browser = false } = {}) {
  if (browser) {
    const { registerGuiOverlays: registerBrowser } = await import('./gui-overlay-browser.mjs');
    return registerBrowser(registerExecutor);
  }

  const { registerToolcallComposite } = await import('./toolcall-graph/register.mjs');
  const { registerMockLLM } = await import('./test-mocks/register.mjs');
  const { registerMemoryExecutors } = await import('./memory-graph/register.mjs');

  registerMemoryExecutors(registerExecutor);
  registerToolcallComposite(registerExecutor);
  registerMockLLM(registerExecutor);
}

export default registerGuiOverlays;
