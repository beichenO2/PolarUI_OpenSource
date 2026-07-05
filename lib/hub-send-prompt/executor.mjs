/**
 * HubSendPrompt — PolarClaw Web Solo Agent 对话工具（原 hub_send_prompt 内部分发）。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLARCLAW_CLIENT = join(__dirname, '../../dist/assets/polarclaw-client-BJrHP7WW.js');

let clientMod = null;

async function loadClient() {
  if (!clientMod) {
    clientMod = await import(POLARCLAW_CLIENT);
  }
  return clientMod;
}

/**
 * @param {object} node
 * @param {Record<string, unknown>} inputs
 */
export async function executeHubSendPrompt(node, inputs) {
  const prompt = String(inputs.task ?? inputs.prompt ?? inputs.hub_message ?? inputs.message ?? 'ping');
  try {
    const { findPolarClawUrl, callPolarClawAgent } = await loadClient();
    const base = String(node.params?.api_base ?? '') || (await findPolarClawUrl());
    const status = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(3000) });
    if (!status.ok) throw new Error(`PolarClaw ${status.status}`);
    const reply = await callPolarClawAgent(base, prompt, inputs.conversation_id);
    return {
      outputs: { reply, url: base, prompt_sent: true },
      duration_ms: 0,
    };
  } catch (err) {
    return {
      outputs: { skipped: true, mock: true, prompt, reply: `[mock] ${prompt}` },
      duration_ms: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default executeHubSendPrompt;
