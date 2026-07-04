#!/usr/bin/env node
/** 运行 taoci-outreach TDD 测试 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLARUI_ROOT = join(ROOT, '../..');

const tests = [
  'tests/link/feishu-im-config.test.mjs',
  'tests/link/feishu-route.test.mjs',
  'tests/link/graph-engine.test.mjs',
  'tests/link/state-machine.test.mjs',
  'tests/scenario/huyoucai-qa.test.mjs',
  join(POLARUI_ROOT, 'workflows/tests/react-replay-graph.test.mjs'),
  join(POLARUI_ROOT, 'workflows/tests/react-lg-routing.test.mjs'),
  join(POLARUI_ROOT, 'lib/toolcall-graph/register.test.mjs'),
];

let failed = 0;
for (const t of tests) {
  const r = spawnSync('node', ['--test', t.startsWith('/') ? t : join(ROOT, t)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) failed += 1;
}

process.exit(failed ? 1 : 0);
