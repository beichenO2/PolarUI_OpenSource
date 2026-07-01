#!/usr/bin/env node
/** 运行 taoci-outreach TDD 测试 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tests = [
  'tests/link/feishu-im-config.test.mjs',
  'tests/link/feishu-route.test.mjs',
  'tests/link/state-machine.test.mjs',
  'tests/scenario/huyoucai-qa.test.mjs',
];

let failed = 0;
for (const t of tests) {
  const r = spawnSync('node', ['--test', join(ROOT, t)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) failed += 1;
}

process.exit(failed ? 1 : 0);
