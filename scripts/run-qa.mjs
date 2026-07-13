#!/usr/bin/env node
/**
 * ADR-010 P0 QA 聚合门禁 — 串联已验证为绿的测试段，输出汇总。
 *
 * R11 视觉门禁：末尾两步 build（vue-tsc 编译门 + 刷新 dist）与
 * test:canvas-baseline（Playwright 双主题截图基线，hermes+light）。
 * 视觉回归由本流水线裁决；截图基线更新（--update-snapshots）是有意
 * 设计变更的唯一人工确认点。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{ id: string; cmd: string; args: string[] }[]} */
const STEPS = [
  { id: 'test:headless', cmd: 'node', args: ['--test', 'lib/headless-engine.test.mjs'] },
  { id: 'run-graph-server', cmd: 'node', args: ['--test', 'lib/run-graph-server.test.mjs'] },
  { id: 'test:gui-overlay', cmd: 'node', args: ['--test', 'lib/gui-overlay.test.mjs', 'lib/gui-overlay-browser.test.mjs'] },
  { id: 'test:toolcall-composite', cmd: 'node', args: ['lib/toolcall-composite.test.mjs'] },
  { id: 'test:toolcall-graph', cmd: 'node', args: ['lib/toolcall-graph/register.test.mjs'] },
  { id: 'test:http-workflow-graph', cmd: 'node', args: ['--test', 'lib/http-workflow-graph/register.test.mjs'] },
  { id: 'test:toolcall-gui', cmd: 'node', args: ['lib/toolcall-gui/tool-list.test.mjs'] },
  { id: 'test:react-replay', cmd: 'node', args: ['--test', 'workflows/tests/react-replay-graph.test.mjs', 'workflows/tests/react-lg-routing.test.mjs'] },
  { id: 'test:engine', cmd: 'node', args: ['--test', 'tests/engine/'] },
  { id: 'test:project-deps', cmd: 'node', args: ['--import', 'tsx', '--test', 'tests/engine/project-deps.test.ts'] },
  { id: 'test:evolution', cmd: 'node', args: ['--import', 'tsx', '--test', 'tests/engine/graph-mutation.test.ts', 'tests/engine/stemcell.test.ts', 'tests/engine/petri-dish.test.ts'] },
  { id: 'test:fn-frame', cmd: 'node', args: ['--import', 'tsx', '--test', 'tests/engine/fn-frame.test.ts', 'tests/engine/fn-def-pilot.test.ts'] },
  { id: 'test:canvas', cmd: 'node', args: ['--import', 'tsx', '--test', 'tests/canvas/graph-groups.test.ts', 'tests/canvas/group-suggest.test.ts', 'tests/canvas/wire-routing.test.ts', 'tests/canvas/wire-routing-snapshot.test.ts', 'tests/canvas/canvas-dblclick.test.ts', 'tests/canvas/canvas-view-cache.test.ts'] },
  { id: 'export-release', cmd: 'node', args: ['--test', 'scripts/export-release.test.mjs', 'scripts/compile-site-config.test.mjs', 'scripts/http-workflows.test.mjs', 'scripts/patch-librechat-http-workflows.test.mjs'] },
  { id: 'claude-code', cmd: 'node', args: ['workflows/claude-code/tests/run.mjs'] },
  { id: 'evolve-demo', cmd: 'node', args: ['scripts/evolve-demo.mjs'] },
  { id: 'evolve-claude-demo', cmd: 'node', args: ['scripts/evolve-claude-demo.mjs'] },
  // 视觉门禁（R11）：先重建 dist（含 vue-tsc 编译检查），再对比双主题截图基线
  { id: 'build', cmd: 'npm', args: ['run', 'build'] },
  { id: 'test:canvas-baseline', cmd: 'npx', args: ['playwright', 'test'] },
];

function runStep(step) {
  return new Promise((resolve) => {
    const child = spawn(step.cmd, step.args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  const results = [];
  let failed = 0;

  console.log('=== PolarUI QA gate (ADR-010 P0) ===\n');

  for (const step of STEPS) {
    const started = Date.now();
    process.stdout.write(`▶ ${step.id} ...\n`);
    const code = await runStep(step);
    const ok = code === 0;
    if (!ok) failed += 1;
    results.push({ id: step.id, ok, ms: Date.now() - started, code });
    console.log(`${ok ? '✓' : '✗'} ${step.id} (${results.at(-1).ms}ms, exit=${code})\n`);
    if (!ok) break;
  }

  console.log('--- QA summary ---');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  (${r.ms}ms)`);
  }
  const pending = STEPS.length - results.length;
  if (pending > 0) {
    for (const step of STEPS.slice(results.length)) {
      console.log(`SKIP  ${step.id}  (aborted)`);
    }
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\nTotal: ${pass}/${STEPS.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
