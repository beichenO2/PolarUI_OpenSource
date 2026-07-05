/**
 * Headless engine smoke — 无 Vue mount，executeGraph 可用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHeadlessEngine, resetHeadlessEngine } from './headless-engine.mjs';

test('loadHeadlessEngine exports executeGraph without Vue mount errors', async () => {
  resetHeadlessEngine();
  const mountErrors = [];
  const origError = console.error;
  console.error = (...args) => {
    const msg = args.map(String).join(' ');
    if (/mount|#app|Vue/i.test(msg)) mountErrors.push(msg);
    origError.apply(console, args);
  };

  try {
    const engine = await loadHeadlessEngine();
    assert.equal(typeof engine.executeGraph, 'function');
    assert.equal(typeof engine.parseWorkflow, 'function');
    assert.equal(typeof engine.registerExecutor, 'function');
    assert.equal(globalThis.__POLAR_HEADLESS__, true);
    assert.equal(mountErrors.length, 0, `unexpected mount errors: ${mountErrors.join('; ')}`);
  } finally {
    console.error = origError;
  }
});
