/**
 * Headless graph engine loader — 无 Vue mount（__POLAR_HEADLESS__ + patch-headless-entry）。
 * 仍复用 dist bundle 的 executor 注册；独立 engine chunk 待 src/ 恢复后替换。
 */
import './shim-browser.mjs';
import { NODE_DEFS_ROOT } from './shim-fetch-node-defs.mjs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEADLESS_ENTRY = join(__dirname, '../dist/assets/headless.mjs');
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

async function importEngineModule() {
  globalThis.__POLAR_HEADLESS__ = true;
  if (existsSync(HEADLESS_ENTRY)) {
    return import(HEADLESS_ENTRY);
  }
  return import(BUNDLE);
}

/**
 * @returns {Promise<{ executeGraph: Function, parseWorkflow: Function, registerExecutor: Function }>}
 */
export async function loadHeadlessEngine() {
  if (_engine) return _engine;

  const mod = await importEngineModule();
  await waitForNodeDefsReady();

  const { registerGuiOverlays } = await import('./gui-overlay.mjs');

  const registerExecutor = mod.registerExecutor ?? mod.r;
  const executeGraph = mod.executeGraph ?? mod.e;
  const parseWorkflow = mod.parseWorkflow ?? mod.l;

  await registerGuiOverlays(registerExecutor, { browser: false });

  if (typeof executeGraph !== 'function') {
    throw new Error('executeGraph export missing from PolarUI headless entry');
  }

  _engine = {
    executeGraph,
    parseWorkflow,
    registerExecutor,
  };
  return _engine;
}

export default loadHeadlessEngine;
