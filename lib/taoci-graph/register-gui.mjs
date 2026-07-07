/**
 * Browser GUI overlay — TaociSubAgent executor (memory nodes in memory-graph/).
 */
import {
  loadSession,
  saveSession,
  appendHistory,
  sessionSummary,
} from './session-hub.mjs';
import {
  applyStep0,
  applyStep1,
  applyStep2,
  applyStep3,
  buildHarnessOutput,
} from './apply-step-core.mjs';

function parseFilesInput(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

let registered = false;

export function resetTaociGuiRegistration() {
  registered = false;
}

/** @param {Function} registerExecutor */
export function registerTaociGuiExecutors(registerExecutor) {
  if (registered) return;
  registered = true;

  registerExecutor('TaociSubAgent', async (node, inputs, ctx) => {
    const conversationId = String(
      inputs.conversation_id
      ?? ctx.runContext?.conversationId
      ?? 'default',
    );
    const session = inputs.session ?? await loadSession(conversationId);
    const agent = String(node.params.agent ?? 'reputation');

    return {
      outputs: {
        result: {
          status: 'stub',
          agent,
          note: 'TaociSubAgent GUI stub — 完整调研请用 CLI/headless 路径',
        },
        status: 'stub',
        agent,
        [agent]: { status: 'stub' },
      },
      duration_ms: 0,
    };
  });
}

export default registerTaociGuiExecutors;
