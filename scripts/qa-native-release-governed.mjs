import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { exportRelease } from './export-release.mjs';
import { assertNameLocks } from './native-web-qa-assertions.mjs';
import { waitForZeroContextReady, workflowInput, workflowInterrupt } from './native-web-qa-readiness.mjs';
import {
  buildGovernedServiceRegistration,
  claimGovernedQaPort,
  registerAndStartGovernedService,
  restartGovernedServiceWithPort,
  runGovernedServiceAction,
  waitForHttp,
} from './governed-qa-services.mjs';

const projectRoot = join(import.meta.dirname, '..');
const taskRoot = '~/Documents/Codex/2026-07-16/workflow-web-deploy-qa';
const workRoot = join(taskRoot, 'work', `native-release-qa-${Date.now()}`);
const outputRoot = join(taskRoot, 'outputs');
mkdirSync(workRoot, { recursive: true });
mkdirSync(outputRoot, { recursive: true });

const suffix = randomBytes(5).toString('hex');
const runId = `${Date.now().toString(36)}-${suffix}`;
const email = `release-${suffix}@example.test`;
const username = `release_${suffix}`;
const password = `Qa-${randomBytes(18).toString('base64url')}`;
const adminEmail = `admin-${suffix}@example.test`;
const adminUsername = `admin_${suffix}`;
const adminPassword = `Admin-${randomBytes(18).toString('base64url')}`;
const reportPath = join(outputRoot, 'native-workflow-web-release-qa.json');
const reportMarkdownPath = join(outputRoot, 'native-workflow-web-release-qa.md');
const desktopScreenshot = join(outputRoot, 'native-workflow-web-release-desktop.png');
const versionArchiveScreenshot = join(outputRoot, 'native-workflow-web-release-version-archive.png');
const mobileScreenshot = join(outputRoot, 'native-workflow-web-release-mobile.png');
const mobileDiscussionScreenshot = join(outputRoot, 'native-workflow-web-release-mobile-discussion.png');
const loginScreenshot = join(outputRoot, 'native-workflow-web-release-login.png');
const failureScreenshot = join(outputRoot, 'native-workflow-web-release-failure.png');
const report = {
  run_id: runId,
  started_at: new Date().toISOString(),
  status: 'running',
  workflow: 'native-web-qa',
  checks: [],
  failures: [],
  services: {},
  release: {},
  screenshots: [],
  contract: {
    manifest: 'product.manifest declares product identity, optional one-click demo login, named intents, and a Stage-independent Workflow endpoint.',
    workflow_bridge: 'The Bridge translates the unified v2 Command Envelope and normalizes reply events, names, two-layer memory updates, Artifacts, Interrupts, Checkpoints, and optional dynamic Stage Projection.',
    template_injection_points: ['product.manifest.json', 'Workflow Bridge runtime endpoint'],
    export_artifacts: ['workflow/snapshot.json', 'product.manifest.json', 'site.config.json', 'migrations/', 'compose.yml', 'Start/start.sh'],
    ownership: 'Native Domain/API exclusively owns authorization, execution cursor, state transitions, optimistic concurrency, and atomic persistence.',
  },
};

let browser;
let page;

function record(name, detail = '') {
  report.checks.push({ name, status: 'passed', detail });
  console.log(`[PASS] ${name}${detail ? `: ${detail}` : ''}`);
}

function renderMarkdown(value) {
  const failures = value.failures.length === 0
    ? '- None.'
    : value.failures.map((failure) => `- ${failure.message}`).join('\n');
  const checks = value.checks.length === 0
    ? '- No checks completed.'
    : value.checks.map((check, index) => `${index + 1}. ${check.name}${check.detail ? `: ${check.detail}` : ''}`).join('\n');
  const screenshots = value.screenshots.length === 0
    ? '- None.'
    : value.screenshots.map((path) => `- \`${path}\``).join('\n');
  return `# Native Workflow Web Release QA

- Run ID: \`${value.run_id}\`
- Status: **${value.status.toUpperCase()}**
- Started: ${value.started_at}
- Finished: ${value.finished_at ?? 'not finished'}
- Passed checks: ${value.checks.length}
- Failed checks: ${value.failures.length}

## Final Contract

- Manifest: ${value.contract.manifest}
- Workflow Bridge: ${value.contract.workflow_bridge}
- Template injection points: ${value.contract.template_injection_points.map((item) => `\`${item}\``).join(', ')}
- Export artifacts: ${value.contract.export_artifacts.map((item) => `\`${item}\``).join(', ')}
- State ownership: ${value.contract.ownership}

## Production Checks

${checks}

## Services

\`\`\`json
${JSON.stringify(value.services, null, 2)}
\`\`\`

## Screenshots

${screenshots}

## Failures

${failures}

## Repeat

\`\`\`bash
cd ~/Polarisor/PolarUI
npm run qa:native-release
\`\`\`
`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${options.label ?? command} failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim());
  }
  return result.stdout.trim();
}

async function waitFor(label, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} timeout${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function waitForServiceStatus(serviceId, expectedStatus) {
  return waitFor(`PolarProcess ${serviceId} ${expectedStatus}`, async () => {
    const response = await fetch(`http://127.0.0.1:11055/api/services/${encodeURIComponent(serviceId)}`);
    if (!response.ok) throw new Error(`cannot inspect governed service: ${serviceId}`);
    const service = await response.json();
    return service.status === expectedStatus ? service : false;
  }, 120_000);
}

async function disableServiceAutoStart(service) {
  if (!service.auto_start && !service.restart_on_failure) return;
  const response = await fetch('http://127.0.0.1:11055/api/services/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: service.id,
      name: service.name,
      command: service.command,
      work_dir: service.work_dir,
      mem_requirement_mb: service.mem_requirement_mb,
      gpu_mem_requirement_mb: service.gpu_mem_requirement_mb,
      device_id: service.device_id,
      auto_start: false,
      restart_on_failure: false,
      max_restarts: service.max_restarts,
      port: service.port,
      health_check_url: service.health_check_url,
      cron_schedule: service.cron_schedule,
      start_script_dir: service.start_script_dir,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.message ?? `cannot disable auto-start for ${service.id}`);
  }
}

async function stopIfRegistered(serviceId) {
  const response = await fetch(`http://127.0.0.1:11055/api/services/${encodeURIComponent(serviceId)}`);
  if (response.status === 404) return;
  if (!response.ok) throw new Error(`cannot inspect existing governed service: ${serviceId}`);
  const service = await response.json();
  await disableServiceAutoStart(service);
  if (service.status !== 'stopped') {
    await runGovernedServiceAction(serviceId, 'stop');
    await waitForServiceStatus(serviceId, 'stopped');
  }
}

async function browserJson(url, init = {}) {
  return page.evaluate(async ({ target, requestInit }) => {
    const response = await fetch(target, requestInit);
    const body = await response.json().catch(() => null);
    return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
  }, { target: url, requestInit: init });
}

async function readTerminalEvent(eventUrl) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { headers: { accept: 'text/event-stream' } });
    const text = await response.text();
    const events = text.split(/\n\n+/).flatMap((frame) => {
      const type = frame.match(/^event:\s*(.+)$/m)?.[1];
      const data = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (!type || !data) return [];
      return [{ type, payload: JSON.parse(data) }];
    });
    return { status: response.status, events, terminal: events.findLast((event) => event.type === 'command.finished') };
  }, eventUrl);
}

async function extractVerificationCode(mailpitOrigin, recipient) {
  return waitFor('verification email', async () => {
    const response = await fetch(`${mailpitOrigin}/api/v1/messages`);
    if (!response.ok) return false;
    const body = await response.json();
    for (const summary of body.messages ?? body.Messages ?? []) {
      if (!JSON.stringify(summary).toLowerCase().includes(recipient.toLowerCase())) continue;
      const id = summary.ID ?? summary.Id ?? summary.id;
      const detail = await (await fetch(`${mailpitOrigin}/api/v1/message/${encodeURIComponent(id)}`)).json();
      const content = [detail.Text, detail.HTML, detail.text, detail.html, JSON.stringify(detail)].filter(Boolean).join('\n');
      return content.match(/验证码[^0-9]{0,40}(\d{6})/u)?.[1] ?? content.match(/\b(\d{6})\b/u)?.[1] ?? false;
    }
    return false;
  }, 30_000);
}

async function login(identifier, loginPassword, expectedUsername) {
  await page.getByLabel('邮箱或用户名').fill(identifier);
  await page.getByLabel('密码').fill(loginPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: `${expectedUsername} · 退出` }).waitFor();
}

function currentIds() {
  const url = new URL(page.url());
  return {
    contextId: url.pathname.match(/\/contexts\/([^/]+)/)?.[1] ?? '',
    routeId: url.pathname.match(/\/routes\/([^/]+)/)?.[1] ?? '',
    conversationId: url.pathname.match(/\/conversations\/([^/]+)/)?.[1] ?? '',
    checkpointId: url.searchParams.get('checkpoint') ?? '',
  };
}

async function sendUiMessage(content, expectedReply) {
  const requestPromise = page.waitForRequest((request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/workflow/commands')) return false;
    try {
      const body = request.postDataJSON();
      return body.input?.type === 'message' && body.input.content === content;
    } catch {
      return false;
    }
  });
  await workflowInput(page).fill(content);
  await page.getByRole('button', { name: '发送 Workflow Input' }).click();
  const request = await requestPromise;
  if (expectedReply) await page.getByText(expectedReply, { exact: true }).waitFor();
  return request.postDataJSON();
}

async function assertFullScreenLayer(locator) {
  const bounds = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
  assert.deepEqual(bounds, { x: 0, y: 0, width: 390, height: 844 });
}

async function assertMinimumInteractiveTarget(locator) {
  const metrics = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      minInlineSize: style.minInlineSize,
      minBlockSize: style.minBlockSize,
      width: bounds.width,
      height: bounds.height,
    };
  });
  assert.equal(metrics.minInlineSize, '44px');
  assert.equal(metrics.minBlockSize, '44px');
  assert(metrics.width >= 44 && metrics.height >= 44);
}

try {
  const runtimeServiceId = 'polarui-native-web-qa-runtime';
  const mailpitServiceId = 'polarui-native-web-qa-mailpit';
  await stopIfRegistered(runtimeServiceId);
  await stopIfRegistered(mailpitServiceId);
  await stopIfRegistered('web-native-web-qa');
  const runtimePort = await claimGovernedQaPort({ serviceName: runtimeServiceId, preferred: 14925 });
  const mailpitHttpPort = await claimGovernedQaPort({ serviceName: mailpitServiceId, preferred: 14940 });
  const mailpitSmtpPort = await claimGovernedQaPort({ serviceName: 'polarui-native-web-qa-smtp', preferred: 14945 });
  assert.equal(new Set([runtimePort, mailpitHttpPort, mailpitSmtpPort]).size, 3);
  record('PolarPort allocated all QA support ports', `${runtimePort},${mailpitHttpPort},${mailpitSmtpPort}`);

  await registerAndStartGovernedService(buildGovernedServiceRegistration({
    id: runtimeServiceId,
    name: 'Native Web QA Workflow Runtime',
    command: `env POLARUI_RUN_PORT=${runtimePort} POLARUI_RUN_DEFAULT_WORKFLOW=native-web-qa NATIVE_WEB_QA_TIMEOUT_MS=1500 ${shellQuote(process.execPath)} lib/run-graph-server.mjs`,
    workDir: projectRoot,
    port: runtimePort,
    healthUrl: `http://127.0.0.1:${runtimePort}/health`,
  }));
  await waitForHttp(`http://127.0.0.1:${runtimePort}/health`);
  const runtimeProbe = await (await fetch(`http://127.0.0.1:${runtimePort}/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contract_version: '2.0',
      workflow_id: 'native-web-qa',
      command: {
        id: '60000000-0000-4000-8000-000000000001',
        context_id: '10000000-0000-4000-8000-000000000001',
        route_id: '20000000-0000-4000-8000-000000000001',
        conversation_id: '30000000-0000-4000-8000-000000000001',
        base_checkpoint_id: '40000000-0000-4000-8000-000000000001',
        expected_checkpoint_version: 0,
        input: { type: 'message', content: '[qa:artifact] runtime probe' },
        attachments: [],
      },
      history: [],
      memory: { user: { items: [] }, context: { items: [] } },
      checkpoint_snapshot: { workflow_state: {}, memory_references: [], artifacts: [] },
    }),
  })).json();
  assert.equal(runtimeProbe.reply, 'Fixture reply · runtime probe');
  assert.equal(runtimeProbe.contract_version, '2.0');
  assert.deepEqual(runtimeProbe.node_traces, ['NativeWebQaFixture', 'Output']);
  report.services.workflow = { id: runtimeServiceId, port: runtimePort };
  record('real headless Workflow fixture is healthy', runtimeProbe.node_traces.join(' -> '));

  await registerAndStartGovernedService(buildGovernedServiceRegistration({
    id: mailpitServiceId,
    name: 'Native Web QA Mail Capture',
    command: `env MAIL_CAPTURE_HTTP_PORT=${mailpitHttpPort} MAIL_CAPTURE_SMTP_PORT=${mailpitSmtpPort} ${shellQuote(process.execPath)} scripts/native-web-qa-mail-capture.mjs`,
    workDir: projectRoot,
    port: mailpitHttpPort,
    healthUrl: `http://127.0.0.1:${mailpitHttpPort}/api/v1/messages`,
  }));
  await waitForHttp(`http://127.0.0.1:${mailpitHttpPort}/api/v1/messages`);
  report.services.mailpit = { id: mailpitServiceId, http_port: mailpitHttpPort, smtp_port: mailpitSmtpPort };
  record('SMTP mail capture is governed and healthy');

  Object.assign(process.env, {
    NODE_ENV: 'production',
    POSTGRES_DB: 'polar',
    POSTGRES_USER: 'polar',
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
    AUTH_PEPPER: randomBytes(36).toString('base64url'),
    PUBLIC_APP_ORIGIN: 'http://127.0.0.1:14935',
    COOKIE_SECURE: 'false',
    SMTP_HOST: 'host.docker.internal',
    SMTP_PORT: String(mailpitSmtpPort),
    SMTP_FROM: 'Native Workflow QA <qa@example.test>',
    SMTP_SECURE: 'false',
    WORKFLOW_ENDPOINT_OVERRIDE: `http://host.docker.internal:${runtimePort}/run`,
    WORKFLOW_TIMEOUT_MS: '1000',
    POLAR_WEB_PREFERRED_PORT: '14935',
    POLAR_NATIVE_COMPOSE_PROJECT: `polar-native-web-qa-${runId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 24)}`,
  });
  const exported = await exportRelease({
    workflow: 'native-web-qa',
    webRoot: join(workRoot, 'releases'),
    templateFlavor: 'native',
    databaseMode: 'bundled',
    skipPreflight: true,
    compileOnly: false,
    silent: true,
  });
  if (!exported.ok) throw new Error(`export/deploy failed: ${JSON.stringify(exported)}`);
  const releasePath = exported.release_path;
  const webPort = exported.deploy.web_port;
  assert.equal(webPort, 14935);
  const webServiceId = exported.deploy.service_id;
  await waitForHttp(`http://127.0.0.1:${webPort}/readyz`);
  report.services.web = { id: webServiceId, port: webPort };
  report.release = {
    id: exported.release_id,
    path: releasePath,
    manifest: exported.manifest,
    deploy: exported.deploy,
  };
  const frozenProduct = JSON.parse(readFileSync(join(releasePath, 'product.manifest.json'), 'utf8'));
  assert.equal(frozenProduct.workflow.id, 'native-web-qa');
  assert.equal(frozenProduct.workflow.endpoint, 'http://127.0.0.1:13925/run');
  assert.deepEqual(frozenProduct.demo_login, {
    email: 'demo@native-web.test',
    username: 'demo',
    password: 'Demo-Workflow-2026!',
  });
  assert.deepEqual(frozenProduct.stages, []);
  assert.deepEqual(frozenProduct.intents, [{ key: 'summarize', label: '生成验收摘要' }]);
  record('export-release compiled and PolarProcess deployed production container', exported.release_id);

  const appOrigin = `http://127.0.0.1:${webPort}`;
  record('production Web container serves the local release directly over HTTP', appOrigin);
  const mailpitOrigin = `http://127.0.0.1:${mailpitHttpPort}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${appOrigin}/login`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.getByLabel('邮箱或用户名').inputValue(), frozenProduct.demo_login.username);
  assert.equal(await page.getByLabel('密码').inputValue(), frozenProduct.demo_login.password);
  await page.screenshot({ path: loginScreenshot, fullPage: true });
  report.screenshots.push(loginScreenshot);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: 'demo · 退出' }).waitFor();
  record('prefilled demo account logs in with one click');
  await page.getByRole('button', { name: 'demo · 退出' }).click();
  await page.goto(`${appOrigin}/register`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '注册并发送验证码' }).click();
  const code = await extractVerificationCode(mailpitOrigin, email);
  assert.match(code, /^\d{6}$/);
  await page.getByLabel('六位验证码').fill(code);
  await page.getByRole('button', { name: '完成验证' }).click();
  await login(email, password, username);
  await waitForZeroContextReady(page);
  record('email registration, verification, and email login');

  const composeProject = exported.deploy.compose_project;
  assert.match(composeProject, /^polar-native-web-qa-[a-z0-9_.-]+$/);
  const safeReleaseId = exported.release_id.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 48);
  const releaseEnv = join(homedir(), '.config', 'polarui', 'release-env', `${safeReleaseId}.env`);
  const webContainer = run('docker', ['compose', '--project-name', composeProject, '--env-file', releaseEnv,
    '-f', join(releasePath, 'compose.yml'), 'ps', '-q', 'web']);
  const postgresContainer = run('docker', ['compose', '--project-name', composeProject, '--env-file', releaseEnv,
    '-f', join(releasePath, 'compose.yml'), 'ps', '-q', 'postgres']);
  assert(webContainer && postgresContainer);
  const postgresPorts = JSON.parse(run('docker', ['inspect', '--format', '{{json .HostConfig.PortBindings}}', postgresContainer]) || 'null');
  assert(!postgresPorts || !postgresPorts['5432/tcp']);
  record('bundled PostgreSQL is internal-only');

  const archiveJson = join(workRoot, 'archive.json');
  const archiveFile = join(workRoot, 'legacy.txt');
  writeFileSync(archiveFile, `legacy-${suffix}`);
  writeFileSync(archiveJson, JSON.stringify({ conversations: [{
    conversationId: `legacy-${suffix}`, title: `历史讨论 ${suffix}`, createdAt: '2025-01-01T00:00:00.000Z',
    messages: [{ messageId: `message-${suffix}`, role: 'user', text: `历史消息 ${suffix}`, createdAt: '2025-01-01T00:00:01.000Z',
      attachments: [{ id: `file-${suffix}`, filename: 'legacy.txt', path: 'legacy.txt', mediaType: 'text/plain' }] }],
  }] }));
  run('docker', ['cp', archiveJson, `${webContainer}:/tmp/archive.json`]);
  run('docker', ['cp', archiveFile, `${webContainer}:/tmp/legacy.txt`]);
  const imported = JSON.parse(run('docker', ['exec', webContainer, 'node', 'apps/api/dist/scripts/import-librechat.js',
    '--input', '/tmp/archive.json', '--attachments-dir', '/tmp', '--target-user', email]));
  assert.equal(imported.failures.length, 0);
  await page.getByRole('button', { name: '导入档案', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`历史讨论 ${suffix}`) }).click();
  await page.getByText(`历史消息 ${suffix}`, { exact: true }).waitFor();
  const importedArchiveLink = page.getByRole('link', { name: 'legacy.txt', exact: true });
  await importedArchiveLink.waitFor();
  await assertMinimumInteractiveTarget(importedArchiveLink);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  record('read-only archive import and browser rendering');

  await page.getByRole('heading', { name: '你现在想处理什么？' }).waitFor();
  const composer = workflowInput(page);
  assert.equal(await composer.isEnabled(), true);
  assert.equal(await page.getByLabel(/名称/).count(), 0);
  const initialAttachmentName = `attachment-${suffix}.txt`;
  await page.getByLabel('添加附件').setInputFiles({
    name: initialAttachmentName,
    mimeType: 'text/plain',
    buffer: Buffer.from(`attachment-${suffix}`),
  });
  await page.getByText(initialAttachmentName, { exact: true }).waitFor();

  await sendUiMessage('[qa:reject] fail before initialization');
  await page.getByRole('alert').filter({ hasText: 'WORKFLOW_INVALID_RESPONSE' }).waitFor();
  assert.equal(await composer.inputValue(), '[qa:reject] fail before initialization');
  assert.equal(await page.getByText(initialAttachmentName, { exact: true }).count(), 1);
  const emptyContexts = await browserJson('/api/contexts');
  assert.deepEqual(emptyContexts.body.contexts, []);
  assert.equal(currentIds().contextId, '');
  await page.screenshot({ path: failureScreenshot, fullPage: true });
  report.screenshots.push(failureScreenshot);
  record('failed first Input retains exact draft and attachment without activating an empty Context');

  const startCommand = await sendUiMessage(
    '[qa:start] establish the release context',
    'Fixture initialized · establish the release context',
  );
  assert.equal(startCommand.attachmentIds.length, 1);
  await page.waitForURL((url) => /\/contexts\/[^/]+\/routes\/[^/]+\/conversations\/[^/]+$/u.test(url.pathname));
  const activeIds = currentIds();
  assert.match(activeIds.contextId, /^[0-9a-f-]{36}$/);
  assert.match(activeIds.routeId, /^[0-9a-f-]{36}$/);
  assert.match(activeIds.conversationId, /^[0-9a-f-]{36}$/);
  await page.getByRole('heading', { name: 'Native Web 发布验证' }).waitFor();
  await page.getByRole('heading', { name: '核心 Input 验收' }).first().waitFor();
  await page.getByRole('link', { name: new RegExp(initialAttachmentName.replace('.', '\\.')) }).waitFor();
  record('first Input atomically activates Agent-named Context, Route, primary Conversation, and attachment');

  const initialContextTitle = 'Native Web 发布验证';
  const initialConversationTitle = '核心 Input 验收';
  const userContextTitle = `用户 Context ${suffix}`;
  const userConversationTitle = `用户 Conversation ${suffix}`;
  const beforeRenameWorkspace = await browserJson(`/api/routes/${activeIds.routeId}/workspace`);
  const beforeRenameMessages = await browserJson(`/api/conversations/${activeIds.conversationId}/messages`);
  let commandRequestsDuringRename = 0;
  const observeRenameRequest = (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/workflow/commands')) {
      commandRequestsDuringRename += 1;
    }
  };
  page.on('request', observeRenameRequest);
  try {
    await page.getByRole('button', { name: `重命名 ${initialContextTitle}` }).click();
    await page.getByLabel('重命名 Context').fill(userContextTitle);
    await page.getByLabel('重命名 Context').press('Enter');
    await page.getByRole('heading', { name: userContextTitle }).waitFor();

    await page.getByRole('button', { name: `重命名 ${initialConversationTitle}` }).first().click();
    await page.getByLabel('重命名 Conversation').fill(userConversationTitle);
    await page.getByLabel('重命名 Conversation').press('Enter');
    await page.getByRole('heading', { name: userConversationTitle }).first().waitFor();
  } finally {
    page.off('request', observeRenameRequest);
  }

  const afterRenameWorkspace = await browserJson(`/api/routes/${activeIds.routeId}/workspace`);
  const afterRenameMessages = await browserJson(`/api/conversations/${activeIds.conversationId}/messages`);
  assert.equal(afterRenameWorkspace.body.route.id, beforeRenameWorkspace.body.route.id);
  assert.deepEqual(
    afterRenameWorkspace.body.checkpoints.map(({ id, parentCheckpointId, version, reason }) => ({
      id, parentCheckpointId, version, reason,
    })),
    beforeRenameWorkspace.body.checkpoints.map(({ id, parentCheckpointId, version, reason }) => ({
      id, parentCheckpointId, version, reason,
    })),
  );
  assert.deepEqual(afterRenameMessages.body, beforeRenameMessages.body);
  assert.equal(commandRequestsDuringRename, 0);

  await sendUiMessage(
    '[qa:rename-attempt] agent must not overwrite user titles',
    'Fixture naming attempt · agent must not overwrite user titles',
  );
  const lockedWorkspace = await browserJson(`/api/routes/${activeIds.routeId}/workspace`);
  assertNameLocks(lockedWorkspace.body, {
    contextTitle: userContextTitle,
    conversationId: activeIds.conversationId,
    conversationTitle: userConversationTitle,
  });
  await page.getByRole('heading', { name: userContextTitle }).waitFor();
  await page.getByRole('heading', { name: userConversationTitle }).first().waitFor();
  assert.equal(await page.getByText('Agent overwrite attempt Context', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Agent overwrite attempt Conversation', { exact: true }).count(), 0);
  record('user Context and Conversation renames remain metadata-only locks after a later Agent naming result');

  const userMemory = await browserJson('/api/memory?scope=user');
  const contextMemory = await browserJson(`/api/memory?scope=context&context=${activeIds.contextId}`);
  assert.equal(userMemory.body.memories[0].key, 'qa_response_style');
  assert.equal(contextMemory.body.memories[0].key, 'qa_release_goal');
  for (const item of [userMemory.body.memories[0], contextMemory.body.memories[0]]) {
    assert.equal(item.version, 1);
    assert(item.source && item.createdAt && item.updatedAt && item.impactScope && item.evidence);
  }
  await page.getByRole('tab', { name: '用户记忆' }).click();
  await page.getByText('qa_response_style', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '情景记忆' }).click();
  await page.getByText('qa_release_goal', { exact: true }).waitFor();
  record('separate user and Context memory updates expose source, timestamps, version, scope, and evidence');

  await page.getByRole('tab', { name: '运行' }).click();
  await page.getByText('动态校验项 1', { exact: true }).waitFor();
  await sendUiMessage('继续组织可交付结果', 'Fixture reply · 继续组织可交付结果');
  await page.getByText('组织交付', { exact: true }).waitFor();
  await sendUiMessage('[qa:projection:0] hide projection', 'Fixture projection · 0');
  await page.getByText('当前没有 Stage Projection。', { exact: true }).waitFor();
  await sendUiMessage('[qa:projection:1] one projection', 'Fixture projection · 1');
  await page.getByText('动态校验项 1', { exact: true }).waitFor();
  await sendUiMessage('[qa:projection:many] dense projection', 'Fixture projection · 8');
  await page.getByRole('button', { name: '查看全部 8 项' }).click();
  const projectionDialog = page.getByRole('dialog', { name: '完整 Stage Projection' });
  await projectionDialog.waitFor();
  assert.equal(await projectionDialog.getByTestId('stage-projection-item').count(), 8);
  const desktopProjectionBounds = await projectionDialog.boundingBox();
  assert(desktopProjectionBounds && desktopProjectionBounds.width < 1440 && desktopProjectionBounds.height < 900);
  await projectionDialog.getByRole('button', { name: '关闭完整 Stage Projection' }).click();
  record('normal messages drive Workflow-owned 0, 1, and 7+ dynamic Stage Projection snapshots');

  const artifactAttachmentName = `artifact-source-${suffix}.txt`;
  await page.getByLabel('添加附件').setInputFiles({
    name: artifactAttachmentName,
    mimeType: 'text/plain',
    buffer: Buffer.from(`artifact-source-${suffix}`),
  });
  await page.getByText(artifactAttachmentName, { exact: true }).waitFor();
  const artifactCommand = await sendUiMessage('[qa:artifact] release contract', 'Fixture reply · release contract');
  const artifactLink = page.getByRole('link', { name: /workflow-report\.txt/ }).first();
  await artifactLink.waitFor();
  await assertMinimumInteractiveTarget(artifactLink);
  const artifactHref = await artifactLink.getAttribute('href');
  assert(artifactHref?.startsWith('/api/assets/artifact/'));
  const replay = await browserJson('/api/workflow/commands', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(artifactCommand),
  });
  assert.equal(replay.status, 202);
  assert.equal(replay.body.commandId, artifactCommand.commandId);
  const mutatedReplay = await browserJson('/api/workflow/commands', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      ...artifactCommand,
      input: { ...artifactCommand.input, content: 'changed' },
    }),
  });
  assert.equal(mutatedReplay.status, 409);
  record('unified Command consumes an attachment, emits a causal Artifact, and remains idempotent');

  await sendUiMessage('[qa:memory-conflict] replace the release authority');
  const interruptForm = workflowInterrupt(page);
  await interruptForm.getByText('这条高影响记忆与现有事实冲突，请确认。', { exact: true }).waitFor();
  assert.equal(await composer.isDisabled(), true);
  await interruptForm.getByRole('textbox', { name: 'Interrupt 回复', exact: true }).fill('确认这次高影响更新');
  await interruptForm.getByRole('button', { name: '继续 Workflow', exact: true }).click();
  await waitFor('normal composer after Interrupt', async () => await composer.isEnabled());
  record('conflicting high-impact memory update interrupts inline and resumes through its public ID');

  const sourceIds = currentIds();
  const sourceWorkspace = await browserJson(`/api/routes/${sourceIds.routeId}/workspace`);
  const sourceHeadId = sourceWorkspace.body.headCheckpoint.id;
  const denseProjectionCheckpoint = sourceWorkspace.body.checkpoints.find(
    ({ snapshot }) => snapshot.stageProjection?.items.length >= 7,
  );
  assert(denseProjectionCheckpoint, 'the source Route must retain its dense Stage Projection Checkpoint');
  const artifactCheckpoint = sourceWorkspace.body.checkpoints.find(
    ({ snapshot }) => snapshot.artifacts.length > 0,
  );
  assert(artifactCheckpoint, 'the source Route must retain its Artifact Checkpoint');
  const archivedCheckpoint = [...sourceWorkspace.body.checkpoints]
    .sort((left, right) => left.version - right.version)[0];
  await page.getByRole('button', { name: '打开版本归档' }).click();
  const versionDialog = page.getByRole('dialog', { name: '版本归档' });
  await versionDialog.waitFor();
  await versionDialog.getByRole('button', {
    name: new RegExp(`^版本 ${String(artifactCheckpoint.version).padStart(2, '0')}`),
  }).click();
  const versionArtifactLink = versionDialog.getByRole('link', { name: /下载workflow-report\.txt/ }).first();
  await versionArtifactLink.waitFor();
  await assertMinimumInteractiveTarget(versionArtifactLink);
  await versionDialog.getByRole('button', {
    name: new RegExp(`^版本 ${String(archivedCheckpoint.version).padStart(2, '0')}`),
  }).click();
  await page.screenshot({ path: versionArchiveScreenshot, fullPage: true });
  report.screenshots.push(versionArchiveScreenshot);
  await versionDialog.getByRole('button', { name: '在此版本继续' }).click();
  await page.getByRole('note').waitFor();
  assert.equal(await composer.inputValue(), '');
  assert.equal(currentIds().checkpointId, archivedCheckpoint.id);
  await sendUiMessage(
    '[qa:history] continue from immutable source',
    'Fixture branched · continue from immutable source',
  );
  await page.waitForURL((url) => {
    const routeId = url.pathname.match(/\/routes\/([^/]+)/)?.[1];
    return Boolean(routeId && routeId !== sourceIds.routeId);
  });
  const historicalResultIds = currentIds();
  assert.notEqual(historicalResultIds.routeId, sourceIds.routeId);
  assert.notEqual(historicalResultIds.conversationId, sourceIds.conversationId);
  await page.getByText(new RegExp(`来源 Checkpoint ${archivedCheckpoint.id}`)).waitFor();
  const sourceAfterBranch = await browserJson(`/api/routes/${sourceIds.routeId}/workspace`);
  assert.equal(sourceAfterBranch.body.headCheckpoint.id, sourceHeadId);
  assert.deepEqual(
    sourceAfterBranch.body.checkpoints.find(({ id }) => id === archivedCheckpoint.id),
    archivedCheckpoint,
  );
  const historicalWorkspace = await browserJson(`/api/routes/${historicalResultIds.routeId}/workspace`);
  assert.equal(
    historicalWorkspace.body.selectedCheckpoint.snapshot.workflowState.history_source.checkpoint_id,
    archivedCheckpoint.id,
  );
  record('historical Input atomically creates an equal Route while preserving exact source history');

  const baseCheckpoint = historicalWorkspace.body.selectedCheckpoint;
  const concurrentBodies = [randomUUID(), randomUUID()].map((commandId) => ({
    commandId,
    contextId: historicalResultIds.contextId,
    routeId: historicalResultIds.routeId,
    conversationId: historicalResultIds.conversationId,
    baseCheckpointId: baseCheckpoint.id,
    expectedCheckpointVersion: baseCheckpoint.version,
    input: { type: 'named_intent', key: 'summarize', content: 'concurrent summary' },
    attachmentIds: [],
  }));
  const receipts = await Promise.all(concurrentBodies.map((body) => browserJson('/api/workflow/commands', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })));
  assert.deepEqual(receipts.map((receipt) => receipt.status), [202, 202]);
  const terminals = await Promise.all(receipts.map((receipt) => readTerminalEvent(receipt.body.eventUrl)));
  const outcomes = terminals.map((result) => result.terminal?.payload?.outcome).sort();
  assert.deepEqual(outcomes, ['conflict', 'succeeded']);
  assert(terminals.some((result) => result.terminal?.payload?.code === 'CHECKPOINT_VERSION_CONFLICT'));
  record('optimistic concurrency conflict commits exactly one command');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('workspace-slot').waitFor();
  assert.deepEqual(currentIds(), historicalResultIds);
  record('refresh restores Context, Route, Conversation, and Checkpoint URL state');

  for (const [message, codeName] of [
    ['[qa:invalid] command', 'WORKFLOW_INVALID_RESPONSE'],
    ['[qa:timeout] command', 'WORKFLOW_TIMEOUT'],
  ]) {
    await sendUiMessage(message);
    await page.getByRole('alert').filter({ hasText: codeName }).waitFor();
  }
  record('Workflow invalid result and timeout fail closed beside their triggering Input');

  const createAdmin = run('docker', ['exec', webContainer, 'node', 'apps/api/dist/scripts/create-user.js',
    '--email', adminEmail, '--username', adminUsername, '--password', adminPassword, '--verified']);
  assert.match(createAdmin, /Created verified user/);
  await page.getByRole('button', { name: `${username} · 退出` }).click();
  await login(adminUsername, adminPassword, adminUsername);
  const isolated = await browserJson(`/api/routes/${sourceIds.routeId}/workspace`);
  assert.equal(isolated.status, 404);
  await page.getByRole('button', { name: `${adminUsername} · 退出` }).click();
  await login(username, password, username);
  await page.goto(`${appOrigin}/contexts/${historicalResultIds.contextId}/routes/${historicalResultIds.routeId}/conversations/${historicalResultIds.conversationId}`);
  await page.getByTestId('workspace-slot').waitFor();
  record('username login and cross-user isolation');

  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopContract = await page.evaluate(() => {
    const shell = document.querySelector('.conversation-first-shell');
    const context = document.querySelector('.context-sidebar-layer');
    const main = document.querySelector('.conversation-axis');
    const inspector = document.querySelector('.workspace-inspector');
    const firstButton = document.querySelector('button');
    firstButton?.focus();
    const buttonStyle = firstButton ? getComputedStyle(firstButton) : null;
    const shellStyle = shell ? getComputedStyle(shell) : null;
    const bodyStyle = getComputedStyle(document.body);
    return {
      columns: shellStyle?.gridTemplateColumns.split(' ').filter(Boolean).length,
      maxInlineSize: shellStyle?.maxInlineSize,
      overflowX: bodyStyle.overflowX,
      minInlineSize: buttonStyle?.minInlineSize,
      minBlockSize: buttonStyle?.minBlockSize,
      outlineStyle: buttonStyle?.outlineStyle,
      domOrder: Boolean(context && main && inspector &&
        (context.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        (main.compareDocumentPosition(inspector) & Node.DOCUMENT_POSITION_FOLLOWING)),
    };
  });
  assert.deepEqual(desktopContract, {
    columns: 3,
    maxInlineSize: '100%',
    overflowX: 'clip',
    minInlineSize: '44px',
    minBlockSize: '44px',
    outlineStyle: 'solid',
    domOrder: true,
  });
  await page.screenshot({ path: desktopScreenshot, fullPage: true });
  report.screenshots.push(desktopScreenshot);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotionDuration = await page.locator('.message-composer').evaluate((element) => (
    Number.parseFloat(getComputedStyle(element).transitionDuration)
  ));
  assert(reducedMotionDuration <= 0.01);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('workspace-slot').waitFor();
  const mobileContract = await page.evaluate(() => {
    const axis = document.querySelector('.conversation-axis');
    const composer = document.querySelector('.message-composer');
    const timeline = document.querySelector('.message-timeline');
    const shell = document.querySelector('.conversation-first-shell');
    if (axis) axis.scrollTop = axis.scrollHeight;
    const lastMessage = document.querySelector('.message-entry:last-of-type');
    const composerBounds = composer?.getBoundingClientRect();
    const lastMessageBounds = lastMessage?.getBoundingClientRect();
    const targets = [...document.querySelectorAll('button,input,textarea,summary,a.download-target')]
      .filter((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
      });
    return {
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      maxInlineSize: shell ? getComputedStyle(shell).maxInlineSize : '',
      composerPosition: composer ? getComputedStyle(composer).position : '',
      composerPaddingBottom: axis ? Number.parseFloat(getComputedStyle(axis).paddingBottom) : 0,
      timelineOverflowY: timeline ? getComputedStyle(timeline).overflowY : '',
      timelineMaxHeight: timeline ? getComputedStyle(timeline).maxHeight : '',
      smallestTarget: Math.min(...targets.map((element) => {
        const bounds = element.getBoundingClientRect();
        return Math.min(bounds.width, bounds.height);
      })),
      finalMessageVisible: !composerBounds || !lastMessageBounds || lastMessageBounds.bottom <= composerBounds.top,
    };
  });
  assert(mobileContract.overflowX <= 0, `mobile horizontal overflow: ${mobileContract.overflowX}`);
  assert.equal(mobileContract.maxInlineSize, '100%');
  assert.equal(mobileContract.composerPosition, 'sticky');
  assert(mobileContract.composerPaddingBottom >= 232);
  assert.equal(mobileContract.timelineOverflowY, 'visible');
  assert.equal(mobileContract.timelineMaxHeight, 'none');
  assert(mobileContract.smallestTarget >= 44);
  assert.equal(mobileContract.finalMessageVisible, true);
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  report.screenshots.push(mobileScreenshot);

  await page.getByRole('button', { name: '打开 Contexts' }).click();
  const contextLayer = page.getByRole('dialog', { name: 'Contexts' });
  await contextLayer.waitFor();
  await assertFullScreenLayer(contextLayer);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '管理 Conversations' }).click();
  const mobileDrawer = page.getByRole('dialog', { name: 'Conversation 管理' });
  await mobileDrawer.waitFor();
  await assertFullScreenLayer(mobileDrawer);
  await page.screenshot({ path: mobileDiscussionScreenshot });
  report.screenshots.push(mobileDiscussionScreenshot);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '打开记忆、成果与运行检查器' }).click();
  const inspectorLayer = page.getByRole('dialog', { name: '工作空间检查器' });
  await inspectorLayer.waitFor();
  await assertFullScreenLayer(inspectorLayer);
  await page.keyboard.press('Escape');

  await page.goto(`${appOrigin}/contexts/${sourceIds.contextId}/routes/${sourceIds.routeId}/conversations/${sourceIds.conversationId}?checkpoint=${denseProjectionCheckpoint.id}`);
  await page.getByTestId('workspace-slot').waitFor();
  await page.getByRole('button', { name: '打开记忆、成果与运行检查器' }).click();
  await page.getByRole('tab', { name: '运行' }).click();
  await page.getByRole('button', { name: '查看全部 8 项' }).click();
  const mobileProjectionDialog = page.getByRole('dialog', { name: '完整 Stage Projection' });
  await mobileProjectionDialog.waitFor();
  await assertFullScreenLayer(mobileProjectionDialog);
  await page.keyboard.press('Escape');
  await mobileProjectionDialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '查看全部 8 项' }).click();
  await mobileProjectionDialog.waitFor();
  await mobileProjectionDialog.getByRole('button', { name: '关闭完整 Stage Projection' }).click();
  await mobileProjectionDialog.waitFor({ state: 'detached' });
  await page.goto(`${appOrigin}/contexts/${sourceIds.contextId}/routes/${sourceIds.routeId}/conversations/${sourceIds.conversationId}?checkpoint=${artifactCheckpoint.id}`);
  await page.getByTestId('workspace-slot').waitFor();
  const mobileArtifactLink = page.getByRole('link', { name: /workflow-report\.txt/ }).first();
  await mobileArtifactLink.waitFor();
  await assertMinimumInteractiveTarget(mobileArtifactLink);

  await page.getByRole('button', { name: '打开版本归档' }).click();
  const mobileVersionArchive = page.getByRole('dialog', { name: '版本归档' });
  await mobileVersionArchive.waitFor();
  await assertFullScreenLayer(mobileVersionArchive);
  const mobileVersionArtifactLink = mobileVersionArchive.getByRole('link', { name: /下载workflow-report\.txt/ }).first();
  await mobileVersionArtifactLink.waitFor();
  await assertMinimumInteractiveTarget(mobileVersionArtifactLink);
  await mobileVersionArchive.getByRole('button', { name: '关闭版本归档' }).click();

  await page.getByRole('button', { name: '导入档案', exact: true }).click();
  const importedArchiveLayer = page.getByRole('dialog', { name: 'LibreChat 历史档案' });
  await importedArchiveLayer.waitFor();
  await assertFullScreenLayer(importedArchiveLayer);
  await importedArchiveLayer.getByRole('button', { name: new RegExp(`历史讨论 ${suffix}`) }).click();
  const mobileArchiveLink = importedArchiveLayer.getByRole('link', { name: 'legacy.txt', exact: true });
  await mobileArchiveLink.waitFor();
  await assertMinimumInteractiveTarget(mobileArchiveLink);
  await importedArchiveLayer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.goto(`${appOrigin}/contexts/${historicalResultIds.contextId}/routes/${historicalResultIds.routeId}/conversations/${historicalResultIds.conversationId}`);
  await page.getByTestId('workspace-slot').waitFor();
  record('desktop and 390px journeys satisfy computed layout, focus, motion, and full-screen layer contracts');

  await restartGovernedServiceWithPort({
    serviceId: webServiceId,
    serviceName: webServiceId,
    preferred: webPort,
    project: 'PolarUI',
  }, { waitForServiceStatus });
  await waitForHttp(`http://127.0.0.1:${webPort}/readyz`, { timeoutMs: 180_000 });
  const restartedWebService = await waitForServiceStatus(webServiceId, 'running');
  assert(
    Number.isInteger(restartedWebService.pid) && restartedWebService.pid > 0,
    `PolarProcess ${webServiceId} must report a positive integer PID`,
  );
  const polarPortResponse = await fetch('http://127.0.0.1:11050/api/list');
  assert.equal(polarPortResponse.ok, true, 'PolarPort ownership list must be readable after restart');
  const polarPortEntries = await polarPortResponse.json();
  assert(Array.isArray(polarPortEntries), 'PolarPort ownership list must be an array');
  const activeWebPortOwners = polarPortEntries.filter((entry) => (
    entry.port === webPort && entry.status === 'active'
  ));
  assert.equal(activeWebPortOwners.length, 1, `port ${webPort} must have exactly one active PolarPort owner`);
  assert.equal(activeWebPortOwners[0].service_name, webServiceId);
  assert.equal(activeWebPortOwners[0].project, 'PolarUI');
  report.services.web = {
    ...report.services.web,
    pid: restartedWebService.pid,
    ownership: activeWebPortOwners[0],
  };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('workspace-slot').waitFor();
  assert.deepEqual(currentIds(), historicalResultIds);
  const restoredAttachments = await browserJson(`/api/conversations/${activeIds.conversationId}/attachments`);
  assert.equal(restoredAttachments.status, 200);
  assert(restoredAttachments.body.attachments.some((asset) => asset.filename === `attachment-${suffix}.txt`));
  await page.goto(`${appOrigin}/contexts/${activeIds.contextId}/routes/${activeIds.routeId}/conversations/${activeIds.conversationId}`);
  await page.getByTestId('workspace-slot').waitFor();
  const restoredArtifact = page.getByRole('link', { name: /workflow-report\.txt/ }).first();
  await restoredArtifact.waitFor();
  assert.equal(await restoredArtifact.getAttribute('href'), artifactHref);
  const restoredObject = await page.evaluate(async (href) => {
    const response = await fetch(href);
    return { status: response.status, body: await response.text() };
  }, artifactHref);
  assert.equal(restoredObject.status, 200);
  assert.match(restoredObject.body, /^artifact · release contract · attachment /u);
  await page.goto(`${appOrigin}/contexts/${historicalResultIds.contextId}/routes/${historicalResultIds.routeId}/conversations/${historicalResultIds.conversationId}`);
  await page.getByTestId('workspace-slot').waitFor();
  record('PolarProcess container restart preserves database, objects, session, and URL state');
  record(
    'governed Web restart retains exact PolarProcess and PolarPort ownership',
    `pid=${restartedWebService.pid}; ownership=${activeWebPortOwners[0].service_name}@${activeWebPortOwners[0].port} (${activeWebPortOwners[0].status})`,
  );

  report.status = 'passed';
  report.finished_at = new Date().toISOString();
  console.log(`[QA PASS] governed native Workflow Web release: ${appOrigin}`);
} catch (error) {
  report.status = 'failed';
  report.failures.push({ message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null });
  report.finished_at = new Date().toISOString();
  if (page) {
    await page.screenshot({ path: failureScreenshot, fullPage: true }).catch(() => {});
    report.screenshots.push(failureScreenshot);
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(reportMarkdownPath, renderMarkdown(report));
  console.log(`[QA REPORT] ${reportPath}`);
  console.log(`[QA REPORT] ${reportMarkdownPath}`);
}
