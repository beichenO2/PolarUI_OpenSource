/**
 * Headless graph engine loader — 无 Vue mount（__POLAR_HEADLESS__ + src/main.ts guard）。
 */
import './shim-browser.mjs';
import { NODE_DEFS_ROOT } from './shim-fetch-node-defs.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHeadlessEntry, resolveMainBundle } from './bundle-assets.mjs';

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
  throw new Error('node-defs boot timeout — node-defs/index.json not ready');
}

async function importEngineModule() {
  globalThis.__POLAR_HEADLESS__ = true;
  const headless = resolveHeadlessEntry();
  if (existsSync(headless)) {
    return import(headless);
  }
  const bundle = resolveMainBundle();
  if (!bundle) {
    throw new Error('PolarUI bundle not found — run npm run build or build:src');
  }
  return import(bundle);
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
