/**
 * Headless graph engine loader — 无固定 sleep，轮询 node-defs 就绪后注册 overlay executors。
 * 仍加载 dist bundle（Vue 侧效应由 jsdom 吸收）；独立 engine chunk 待 src/ 恢复后替换。
 */
import './shim-browser.mjs';
import { NODE_DEFS_ROOT } from './shim-fetch-node-defs.mjs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(__dirname, '../dist/assets/index-Dh0id7gB.js');

let _engine = null;

export function resetHeadlessEngine() {
  _engine = null;
}

/** 轮询 node-defs/index.json 就绪，替代固定 2500ms sleep */
export async function waitForNodeDefsReady({ timeoutMs = 8000, intervalMs = 100 } = {}) {
  const indexPath = join(NODE_DEFS_ROOT, 'index.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(indexPath)) {
      try {
        const res = await fetch('/node-defs/index.json');
        if (res.ok) return;
      } catch {
        /* retry */
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('node-defs boot timeout — dist/node-defs/index.json not ready');
}

/**
 * @returns {Promise<{ executeGraph: Function, parseWorkflow: Function, registerExecutor: Function }>}
 */
export async function loadHeadlessEngine() {
  if (_engine) return _engine;

  const mod = await import(BUNDLE);
  await waitForNodeDefsReady();

  const { registerTaociExecutors } = await import('./taoci-graph/register.mjs');
  const { registerToolcallComposite } = await import('./toolcall-graph/register.mjs');
  const { registerMockLLM } = await import('./test-mocks/register.mjs');

  registerTaociExecutors(mod.r);
  registerToolcallComposite(mod.r);
  registerMockLLM(mod.r);

  mod.r('FeishuIM', async (node, inputs) => {
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

  if (typeof mod.e !== 'function') {
    throw new Error('executeGraph export missing from PolarUI bundle');
  }

  _engine = {
    executeGraph: mod.e,
    parseWorkflow: mod.l,
    registerExecutor: mod.r,
  };
  return _engine;
}

export default loadHeadlessEngine;
