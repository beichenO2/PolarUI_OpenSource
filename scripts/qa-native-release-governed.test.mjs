import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('stops the stable production Web service before exporting a rerun', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');
  const stopIndex = source.indexOf("await stopIfRegistered('web-native-web-qa')");
  const cleanupIndex = source.indexOf('cleanupStaleQaComposeProjects();', stopIndex);
  const exportIndex = source.indexOf('const exported = await exportRelease');

  assert.notEqual(stopIndex, -1, 'the stable production Web service must be stopped through PolarProcess');
  assert.ok(stopIndex < cleanupIndex && cleanupIndex < exportIndex,
    'the existing Web service must stop before stale Compose projects are removed and the replacement is exported');
  assert.match(source, /await disableServiceAutoStart\(service\)/);
  assert.match(source, /restart_on_failure: false/);
  assert.match(source, /await waitForServiceStatus\(serviceId, 'stopped'\)/);
});

test('removes stale native QA Compose containers and networks without deleting volumes', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /function cleanupStaleQaComposeProjects\(\)/);
  assert.match(source, /entry\.Name\.startsWith\('polar-native-web-qa-'\)/);
  assert.match(source, /configPath\.startsWith\(`\$\{join\(taskRoot, 'work'\)\}\/`\)/);
  assert.match(source, /'down', '--remove-orphans'/);
  assert.doesNotMatch(source, /'down', '--remove-orphans', '--volumes'/);
});

test('waits for the expected authenticated user before issuing QA API requests', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /async function login\(identifier, loginPassword, expectedUsername\)/);
  assert.match(source, /getByRole\('button', \{ name: `\$\{expectedUsername\} · 退出` \}\)\.waitFor\(\)/);
});

test('proves the production demo login is prefilled and requires only one click', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /getByLabel\('邮箱或用户名'\)\.inputValue\(\)/);
  assert.match(source, /getByLabel\('密码'\)\.inputValue\(\)/);
  assert.match(source, /record\('prefilled demo account logs in with one click'\)/);
});

test('serves the local production release directly over HTTP without a TLS proxy', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /PUBLIC_APP_ORIGIN: 'http:\/\/127\.0\.0\.1:14935'/);
  assert.match(source, /COOKIE_SECURE: 'false'/);
  assert.match(source, /POLAR_WEB_PREFERRED_PORT: '14935'/);
  assert.match(source, /assert\.equal\(webPort, 14935\)/);
  assert.match(source, /const appOrigin = `http:\/\/127\.0\.0\.1:\$\{webPort\}`/);
  assert.doesNotMatch(source, /TLS Proxy|tlsServiceId|qa-tls-certificate|https:\/\/127\.0\.0\.1/);
});

test('verifies restart persistence against the original asset Thread scope', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /browserJson\(`\/api\/threads\/\$\{activeIds\.threadId\}\/attachments`\)/);
  assert.match(source, /browserJson\(`\/api\/routes\/\$\{activeIds\.routeId\}\/stages\/\$\{activeIds\.stageKey\}\/artifacts`\)/);
  assert.match(source, /assert\.deepEqual\(currentIds\(\), versionRouteIds\)/);
});

test('exercises the layered workspace instead of legacy notes or derived-route UI', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');
  const artifactCommandIndex = source.indexOf("const artifactCommand = await sendUiMessage");
  const proposalIndex = source.indexOf("filter({ hasText: 'qa_fact' })", artifactCommandIndex);
  const adoptIndex = source.indexOf("runNamedAction('采纳到当前路线'", proposalIndex);
  const closeIndex = source.indexOf("getByRole('button', { name: '关闭讨论' }).click()", adoptIndex);
  const artifactRefreshIndex = source.indexOf("page.locator('.artifact-panel').getByRole('button', { name: '刷新' }).click()", closeIndex);
  const artifactIndex = source.indexOf("getByRole('link', { name: /workflow-report\\.txt/ }).waitFor()", artifactRefreshIndex);

  assert.match(source, /getByRole\('button', \{ name: \/打开讨论\/ \}\)\.click\(\)/);
  assert.match(source, /getByRole\('dialog', \{ name: '阶段讨论' \}\)\.waitFor\(\)/);
  assert.match(source, /getByRole\('button', \{ name: '版本', exact: true \}\)\.click\(\)/);
  assert.match(source, /const versionDialog = page\.getByRole\('dialog', \{ name: '版本归档' \}\);\s+await versionDialog\.waitFor\(\)/);
  assert.match(source, /getByRole\('button', \{ name: '基于此版本新建路线' \}\)\.click\(\)/);
  assert.match(source, /getByText\(\/\^来源：\.\*\\\/ 版本 00\$\/\)\.waitFor\(\)/);
  assert.match(source, /getByRole\('button', \{ name: \/\^版本 00\/ \}\)\.click\(\)/);
  assert.match(source, /getByRole\('heading', \{ name: '创建第一个工作空间' \}\)\.waitFor\(\)/);
  assert.match(source, /getByLabel\('工作空间名称'\)\.fill/);
  assert.match(source, /getByRole\('button', \{ name: '创建工作空间' \}\)\.click\(\)/);
  assert.ok(artifactCommandIndex < proposalIndex && proposalIndex < adoptIndex && adoptIndex < closeIndex &&
    closeIndex < artifactRefreshIndex && artifactRefreshIndex < artifactIndex,
    'memory stays in the discussion drawer, then Stage artifacts are checked after closing the modal');
  assert.match(source, /assert\.equal\(await page\.getByText\('当前浏览位置的未提交笔记'\)\.count\(\), 0\)/);
  assert.match(source, /assert\.equal\(await page\.getByText\('派生路线'\)\.count\(\), 0\)/);
  assert.doesNotMatch(source, /新建线程|线程标题|检查点 00|正在浏览历史检查点|Derived Route|来源：归档版本|创建第一个项目|项目名称|创建项目/);
});

test('captures stage-first, version archive, and full-screen mobile discussion evidence', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /native-workflow-web-release-version-archive\.png/);
  assert.match(source, /native-workflow-web-release-mobile-discussion\.png/);
  assert.match(source, /assert\.deepEqual\(drawerBounds, \{ x: 0, y: 0, width: 390, height: 844 \}\)/);
  assert.match(source, /native-workflow-web-release-qa\.md/);
});
