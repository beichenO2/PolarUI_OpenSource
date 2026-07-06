/**
 * Unified executor overlay — headless (Node) + GUI (browser).
 * Headless: full taoci + toolcall + mock LLM + Feishu + HubSendPrompt.
 * GUI: taoci browser executors + Feishu mock shim.
 */

/**
 * @param {Function} registerExecutor
 * @param {{ browser?: boolean }} [opts]
 */
export async function registerGuiOverlays(registerExecutor, { browser = false } = {}) {
  if (browser) {
    const { registerTaociGuiExecutors } = await import('./taoci-graph/register-gui.mjs');
    registerTaociGuiExecutors(registerExecutor);
    registerExecutor('FeishuIM', async (node, inputs) => {
      if (typeof process !== 'undefined' && (process.env?.TAOCI_MOCK_FEISHU === '1' || process.env?.TAOCI_MOCK_PDF === '1')) {
        return {
          outputs: { status: 'ok', sent: true, bot_name: String(node.params?.bot_name ?? 'PolarClaw_Rr') },
          duration_ms: 0,
        };
      }
      return {
        outputs: {
          status: 'ok',
          sent: false,
          bot_name: String(node.params?.bot_name ?? 'PolarClaw_Rr'),
          note: 'FeishuIM GUI — 真实发信请走 PolarClaw @套辞',
        },
        duration_ms: 0,
      };
    });
    return;
  }

  const { registerTaociExecutors } = await import('./taoci-graph/register.mjs');
  const { registerToolcallComposite } = await import('./toolcall-graph/register.mjs');
  const { registerMockLLM } = await import('./test-mocks/register.mjs');
  const { registerHubSendPrompt } = await import('./hub-send-prompt/register.mjs');

  registerTaociExecutors(registerExecutor);
  registerToolcallComposite(registerExecutor);
  registerMockLLM(registerExecutor);
  registerHubSendPrompt(registerExecutor);

  registerExecutor('FeishuIM', async (node, inputs) => {
    if (process.env.TAOCI_MOCK_FEISHU === '1' || process.env.TAOCI_MOCK_PDF === '1') {
      return {
        outputs: {
          status: 'ok',
          sent: true,
          bot_name: String(node.params?.bot_name ?? 'PolarClaw_Rr'),
        },
        duration_ms: 0,
      };
    }
    const { executeFeishuIM } = await import('./feishu-im/executor.mjs');
    return executeFeishuIM(node, inputs);
  });
}

export default registerGuiOverlays;
