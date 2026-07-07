/**
 * Browser-only GUI executor overlay — no Node/headless imports.
 * Copied to dist/overlay/gui-overlay.mjs for Vite dev + production boot.
 */

/**
 * @param {Function} registerExecutor
 */
export async function registerGuiOverlays(registerExecutor) {
  const { registerTaociGuiExecutors } = await import('./taoci-graph/register-gui.mjs');
  const { registerMemoryGuiExecutors } = await import('./memory-graph/register-gui.mjs');
  registerMemoryGuiExecutors(registerExecutor);
  registerTaociGuiExecutors(registerExecutor);
}

export default registerGuiOverlays;
