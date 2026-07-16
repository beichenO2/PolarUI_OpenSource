import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('stops the stable production Web service before exporting a rerun', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');
  const stopIndex = source.indexOf("await stopIfRegistered('web-native-web-qa')");
  const exportIndex = source.indexOf('const exported = await exportRelease');

  assert.notEqual(stopIndex, -1, 'the stable production Web service must be stopped through PolarProcess');
  assert.ok(stopIndex < exportIndex, 'the existing Web service must stop before export-release deploys its replacement');
  assert.match(source, /await disableServiceAutoStart\(service\)/);
  assert.match(source, /await waitForServiceStatus\(serviceId, 'stopped'\)/);
});

test('waits for the expected authenticated user before issuing QA API requests', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /async function login\(identifier, loginPassword, expectedUsername\)/);
  assert.match(source, /getByRole\('button', \{ name: `\$\{expectedUsername\} · 退出` \}\)\.waitFor\(\)/);
});

test('verifies restart persistence against the original asset Thread scope', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /browserJson\(`\/api\/threads\/\$\{activeIds\.threadId\}\/attachments`\)/);
  assert.match(source, /browserJson\(`\/api\/routes\/\$\{activeIds\.routeId\}\/stages\/\$\{activeIds\.stageKey\}\/artifacts`\)/);
  assert.match(source, /assert\.deepEqual\(currentIds\(\), versionRouteIds\)/);
});

test('exercises the layered workspace instead of legacy notes or derived-route UI', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /getByRole\('button', \{ name: \/打开讨论\/ \}\)\.click\(\)/);
  assert.match(source, /getByRole\('dialog', \{ name: '阶段讨论' \}\)\.waitFor\(\)/);
  assert.match(source, /getByRole\('button', \{ name: '版本', exact: true \}\)\.click\(\)/);
  assert.match(source, /const versionDialog = page\.getByRole\('dialog', \{ name: '版本归档' \}\);\s+await versionDialog\.waitFor\(\)/);
  assert.match(source, /getByRole\('button', \{ name: '基于此版本新建路线' \}\)\.click\(\)/);
  assert.match(source, /getByRole\('button', \{ name: \/\^版本 00\/ \}\)\.click\(\)/);
  assert.match(source, /assert\.equal\(await page\.getByText\('当前浏览位置的未提交笔记'\)\.count\(\), 0\)/);
  assert.match(source, /assert\.equal\(await page\.getByText\('派生路线'\)\.count\(\), 0\)/);
  assert.doesNotMatch(source, /新建线程|线程标题|检查点 00|正在浏览历史检查点|Derived Route/);
});

test('captures stage-first, version archive, and full-screen mobile discussion evidence', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /native-workflow-web-release-version-archive\.png/);
  assert.match(source, /native-workflow-web-release-mobile-discussion\.png/);
  assert.match(source, /assert\.deepEqual\(drawerBounds, \{ x: 0, y: 0, width: 390, height: 844 \}\)/);
  assert.match(source, /native-workflow-web-release-qa\.md/);
});
