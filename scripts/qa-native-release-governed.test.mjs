import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('reuses one exact textbox-role locator for every Workflow Input composer access', async () => {
  const readiness = await import('./native-web-qa-readiness.mjs').catch(() => ({}));
  assert.equal(typeof readiness.workflowInput, 'function');
  const composer = { kind: 'composer' };
  const fakePage = {
    getByRole(role, options) {
      assert.deepEqual([role, options], ['textbox', { name: 'Workflow Input', exact: true }]);
      return composer;
    },
    getByLabel(name) {
      throw new Error(`strict mode violation: ${name} resolved to multiple elements`);
    },
  };

  assert.equal(readiness.workflowInput(fakePage), composer);
});

test('scopes every Interrupt locator to one exact named form', async () => {
  const readiness = await import('./native-web-qa-readiness.mjs').catch(() => ({}));
  assert.equal(typeof readiness.workflowInterrupt, 'function');
  const interruptForm = { kind: 'interrupt-form' };
  const fakePage = {
    getByRole(role, options) {
      assert.deepEqual([role, options], ['form', { name: 'Workflow Interrupt', exact: true }]);
      return interruptForm;
    },
    getByText(name) {
      throw new Error(`global duplicate text locator is forbidden: ${name}`);
    },
    getByLabel(name) {
      throw new Error(`global label locator is forbidden: ${name}`);
    },
  };

  assert.equal(readiness.workflowInterrupt(fakePage), interruptForm);
});

test('waits for the current zero-Context heading and an enabled Workflow Input after login', async () => {
  const readiness = await import('./native-web-qa-readiness.mjs').catch(() => ({}));
  assert.equal(typeof readiness.waitForZeroContextReady, 'function');
  const calls = [];
  let enabledChecks = 0;
  const heading = { waitFor: async () => { calls.push('heading.waitFor'); } };
  const composer = {
    waitFor: async () => { calls.push('composer.waitFor'); },
    isEnabled: async () => {
      enabledChecks += 1;
      calls.push(`composer.isEnabled:${enabledChecks}`);
      return enabledChecks >= 2;
    },
  };
  const fakePage = {
    getByRole(role, options) {
      calls.push(`getByRole:${role}:${options.name}:${options.exact ?? false}`);
      if (role === 'heading') {
        assert.deepEqual(options, { name: '你现在想处理什么？' });
        return heading;
      }
      assert.deepEqual([role, options], ['textbox', { name: 'Workflow Input', exact: true }]);
      return composer;
    },
    getByLabel(name) {
      throw new Error(`strict mode violation: ${name} resolved to textarea and 发送 Workflow Input button`);
    },
  };

  const result = await readiness.waitForZeroContextReady(fakePage, { timeoutMs: 100, pollIntervalMs: 0 });

  assert.equal(result, composer);
  assert.deepEqual(calls, [
    'getByRole:heading:你现在想处理什么？:false',
    'heading.waitFor',
    'getByRole:textbox:Workflow Input:true',
    'composer.waitFor',
    'composer.isEnabled:1',
    'composer.isEnabled:2',
  ]);
});

test('uses exact reusable composer readiness instead of stale or fuzzy locators', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /import \{ waitForZeroContextReady, workflowInput, workflowInterrupt \} from '\.\/native-web-qa-readiness\.mjs'/);
  assert.match(source, /await waitForZeroContextReady\(page\)/);
  assert.equal(source.match(/workflowInput\(page\)/g)?.length, 2);
  assert.doesNotMatch(source, /getByLabel\('Workflow Input'\)/);
  assert.doesNotMatch(source, /创建第一个工作空间/);
});

test('scopes Interrupt prompt, reply, and continue controls to the named Interrupt form', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /const interruptForm = workflowInterrupt\(page\)/);
  assert.match(source, /interruptForm\.getByText\('这条高影响记忆与现有事实冲突，请确认。', \{ exact: true \}\)\.waitFor\(\)/);
  assert.match(source, /interruptForm\.getByRole\('textbox', \{ name: 'Interrupt 回复', exact: true \}\)\.fill\('确认这次高影响更新'\)/);
  assert.match(source, /interruptForm\.getByRole\('button', \{ name: '继续 Workflow', exact: true \}\)\.click\(\)/);
  assert.doesNotMatch(source, /page\.getByText\('这条高影响记忆与现有事实冲突，请确认。'/);
  assert.doesNotMatch(source, /page\.getByLabel\('Interrupt 回复'\)/);
  assert.doesNotMatch(source, /page\.getByRole\('button', \{ name: '继续 Workflow'/);
});

test('asserts user name locks against the real public workspace shape', async () => {
  const assertions = await import('./native-web-qa-assertions.mjs').catch(() => ({}));
  assert.equal(typeof assertions.assertNameLocks, 'function');
  const workspace = {
    context: {
      id: '10000000-0000-4000-8000-000000000001',
      title: '用户 Context',
      status: 'active',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:01:00.000Z',
    },
    conversations: [{
      id: '30000000-0000-4000-8000-000000000001',
      title: '用户 Conversation',
      titleSource: 'user',
    }],
  };
  assert.equal(Object.hasOwn(workspace.context, 'titleSource'), false);

  assert.doesNotThrow(() => assertions.assertNameLocks(workspace, {
    contextTitle: '用户 Context',
    conversationId: '30000000-0000-4000-8000-000000000001',
    conversationTitle: '用户 Conversation',
  }));
});

test('stops the stable production Web service before exporting a rerun', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');
  const stopIndex = source.indexOf("await stopIfRegistered('web-native-web-qa')");
  const exportIndex = source.indexOf('const exported = await exportRelease');

  assert.notEqual(stopIndex, -1, 'the stable production Web service must be stopped through PolarProcess');
  assert.ok(stopIndex < exportIndex,
    'the existing Web service must stop through PolarProcess before the replacement is exported');
  assert.match(source, /await disableServiceAutoStart\(service\)/);
  assert.match(source, /restart_on_failure: false/);
  assert.match(source, /await waitForServiceStatus\(serviceId, 'stopped'\)/);
});

test('never owns Docker Compose or raw service lifecycle outside PolarProcess', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /cleanupStaleQaComposeProjects/);
  assert.doesNotMatch(source, /'docker', \['compose',[\s\S]{0,240}'(?:up|down|start|stop|restart|kill|rm)'/);
  assert.doesNotMatch(source, /docker compose (?:up|down|start|stop|restart|kill|rm)/);
  assert.doesNotMatch(source, /process\.kill|SIGTERM|SIGKILL/);
  assert.doesNotMatch(source, /runGovernedServiceAction\(webServiceId, 'restart'\)/);
  assert.match(source, /restartGovernedServiceWithPort\(\{[\s\S]{0,240}serviceId: webServiceId,[\s\S]{0,240}serviceName: webServiceId,[\s\S]{0,240}preferred: webPort/);
});

test('verifies the restarted Web PID and its single exact active PolarPort owner', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /const restartedWebService = await waitForServiceStatus\(webServiceId, 'running'\)/);
  assert.match(source, /Number\.isInteger\(restartedWebService\.pid\)/);
  assert.match(source, /fetch\('http:\/\/127\.0\.0\.1:11050\/api\/list'/);
  assert.match(source, /activeWebPortOwners[\s\S]{0,320}entry\.port === webPort[\s\S]{0,320}entry\.status === 'active'/);
  assert.match(source, /assert\.equal\(activeWebPortOwners\.length, 1/);
  assert.match(source, /assert\.equal\(activeWebPortOwners\[0\]\.service_name, webServiceId\)/);
  assert.match(source, /report\.services\.web = \{[\s\S]{0,240}pid: restartedWebService\.pid,[\s\S]{0,240}ownership: activeWebPortOwners\[0\]/);
  assert.equal(source.match(/^\s*record\(/gm)?.length, 24);
  assert.match(source, /record\(\s*'governed Web restart retains exact PolarProcess and PolarPort ownership',[\s\S]{0,240}pid=[\s\S]{0,240}ownership=/);
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

test('verifies restart persistence against the original Conversation and Artifact scope', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /browserJson\(`\/api\/conversations\/\$\{activeIds\.conversationId\}\/attachments`\)/);
  assert.match(source, /getByRole\('link', \{ name: \/workflow-report\\\.txt\/ \}\)/);
  assert.match(source, /assert\.deepEqual\(currentIds\(\), historicalResultIds\)/);
});

test('exercises unified Command initialization, dynamic projection, memory, and exact history branching', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /\/api\/workflow\/commands/);
  assert.match(source, /workflowInput\(page\)/);
  assert.match(source, /\[qa:reject\] fail before initialization/);
  assert.match(source, /\[qa:start\] establish the release context/);
  assert.match(source, /\[qa:projection:0\]/);
  assert.match(source, /\[qa:projection:1\]/);
  assert.match(source, /\[qa:projection:many\]/);
  assert.match(source, /\[qa:memory-conflict\]/);
  assert.match(source, /getByRole\('tab', \{ name: '用户记忆' \}\)/);
  assert.match(source, /getByRole\('tab', \{ name: '情景记忆' \}\)/);
  assert.match(source, /\[qa:history\] continue from immutable source/);
  assert.match(source, /const versionDialog = page\.getByRole\('dialog', \{ name: '版本归档' \}\);\s+await versionDialog\.waitFor\(\)/);
  assert.match(source, /getByRole\('button', \{ name: '在此版本继续' \}\)\.click\(\)/);
  assert.match(source, /getByRole\('note'\)/);
  assert.doesNotMatch(source, /\/api\/threads\/|\/stages\/|stageKey|threadId|阶段讨论|工作空间名称|创建工作空间/);
});

test('proves user renames are metadata-only locks that survive a later Agent naming result', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');

  assert.match(source, /const beforeRenameWorkspace = await browserJson/);
  assert.match(source, /const beforeRenameMessages = await browserJson/);
  assert.match(source, /commandRequestsDuringRename/);
  assert.match(source, /getByRole\('button', \{ name: `重命名 \$\{initialContextTitle\}` \}\)/);
  assert.match(source, /getByLabel\('重命名 Context'\)/);
  assert.match(source, /getByRole\('button', \{ name: `重命名 \$\{initialConversationTitle\}` \}\)/);
  assert.match(source, /getByLabel\('重命名 Conversation'\)/);
  assert.match(source, /afterRenameWorkspace\.body\.checkpoints\.map/);
  assert.match(source, /assert\.deepEqual\(afterRenameMessages\.body, beforeRenameMessages\.body\)/);
  assert.match(source, /assert\.equal\(commandRequestsDuringRename, 0\)/);
  assert.match(source, /\[qa:rename-attempt\] agent must not overwrite user titles/);
  assert.match(source, /assertNameLocks\(lockedWorkspace\.body, \{/);
  assert.doesNotMatch(source, /lockedWorkspace\.body\.context\.titleSource/);
  assert.match(source, /getByRole\('heading', \{ name: userContextTitle \}\)/);
  assert.match(source, /getByRole\('heading', \{ name: userConversationTitle \}\)/);
});

test('checks desktop and 390px computed accessibility/layout contracts and full-screen layers', async () => {
  const source = await readFile(new URL('./qa-native-release-governed.mjs', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../templates/native-web/apps/web/src/styles.css', import.meta.url), 'utf8');

  assert.match(source, /native-workflow-web-release-version-archive\.png/);
  assert.match(source, /native-workflow-web-release-mobile-discussion\.png/);
  assert.match(source, /getComputedStyle/);
  assert.match(source, /minInlineSize/);
  assert.match(source, /minBlockSize/);
  assert.match(source, /maxInlineSize/);
  assert.match(source, /composerPaddingBottom/);
  assert.match(source, /overflowX/);
  assert.match(source, /emulateMedia\(\{ reducedMotion: 'reduce' \}\)/);
  assert.match(source, /getByRole\('dialog', \{ name: 'Contexts' \}\)/);
  assert.match(source, /getByRole\('dialog', \{ name: 'Conversation 管理' \}\)/);
  assert.match(source, /getByRole\('dialog', \{ name: '工作空间检查器' \}\)/);
  assert.match(source, /getByRole\('button', \{ name: '查看全部 8 项' \}\)/);
  assert.match(source, /const mobileProjectionDialog = page\.getByRole\('dialog', \{ name: '完整 Stage Projection' \}\)/);
  assert.match(source, /assertFullScreenLayer\(mobileProjectionDialog\)/);
  assert.match(source, /mobileProjectionDialog\.getByRole\('button', \{ name: '关闭完整 Stage Projection' \}\)\.click\(\)/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.stage-projection-drawer\s*\{[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*max-height: none/);
  assert.match(source, /button,input,textarea,summary,a\.download-target/);
  assert.match(source, /assertMinimumInteractiveTarget\(artifactLink\)/);
  assert.match(source, /assertMinimumInteractiveTarget\(importedArchiveLink\)/);
  assert.match(source, /assertMinimumInteractiveTarget\(versionArtifactLink\)/);
  assert.match(source, /assertMinimumInteractiveTarget\(mobileArtifactLink\)/);
  assert.match(styles, /a\.download-target\s*\{[^}]*min-inline-size: 44px;[^}]*min-block-size: 44px;/);
  assert.doesNotMatch(styles, /(?:^|\n)a\s*\{[^}]*min-(?:inline|block)-size:/);
  assert.match(source, /assertFullScreenLayer/);
  assert.match(source, /native-workflow-web-release-qa\.md/);
});
