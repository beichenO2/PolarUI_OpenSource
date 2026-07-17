import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { exportRelease } from './export-release.mjs';
import {
  buildGovernedServiceRegistration,
  claimGovernedQaPort,
  registerAndStartGovernedService,
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
    manifest: 'product.manifest declares product identity, optional one-click demo login, Stage projection, legal actions, fixed component keys, Artifact rules, and the Workflow endpoint.',
    workflow_bridge: 'The Bridge translates the versioned Command Envelope to Workflow input and normalizes reply_events, stage_signal, artifact_proposals, memory_proposals, and workflow_cursor.',
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

function cleanupStaleQaComposeProjects() {
  const projects = JSON.parse(run('docker', ['compose', 'ls', '--all', '--format', 'json']) || '[]');
  const releaseEnv = join(homedir(), '.config', 'polarui', 'release-env', 'native-web-qa.env');
  let cleaned = 0;

  for (const entry of projects) {
    if (!entry.Name.startsWith('polar-native-web-qa-')) continue;
    const configPath = String(entry.ConfigFiles ?? '').split(',').find((candidate) => candidate.endsWith('/compose.yml'));
    if (!configPath || !configPath.startsWith(`${join(taskRoot, 'work')}/`)) continue;
    run('docker', ['compose', '--project-name', entry.Name, '--env-file', releaseEnv,
      '-f', configPath, 'down', '--remove-orphans'], { label: `remove stale QA Compose project ${entry.Name}` });
    cleaned += 1;
  }

  console.log(`[QA CLEANUP] removed ${cleaned} stale native Web QA Compose project(s); volumes preserved`);
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
    stageKey: url.pathname.match(/\/stages\/([^/]+)/)?.[1] ?? '',
    threadId: url.searchParams.get('thread') ?? '',
  };
}

async function sendUiMessage(content, expectedReply) {
  const requestPromise = page.waitForRequest((request) => {
    if (request.method() !== 'POST' || !/\/api\/threads\/[0-9a-f-]+\/commands$/u.test(request.url())) return false;
    try { return request.postDataJSON().kind === 'message' && request.postDataJSON().content === content; } catch { return false; }
  });
  await page.getByLabel('消息内容').fill(content);
  await page.getByRole('button', { name: '发送消息' }).click();
  const request = await requestPromise;
  await page.getByText(expectedReply, { exact: true }).waitFor();
  return request.postDataJSON();
}

async function runNamedAction(label, expectedReply) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByText(expectedReply, { exact: true }).waitFor();
}

try {
  const runtimeServiceId = 'polarui-native-web-qa-runtime';
  const mailpitServiceId = 'polarui-native-web-qa-mailpit';
  await stopIfRegistered(runtimeServiceId);
  await stopIfRegistered(mailpitServiceId);
  await stopIfRegistered('web-native-web-qa');
  cleanupStaleQaComposeProjects();
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
    body: JSON.stringify({ workflowId: 'native-web-qa', sessionId: 'probe', message: '[qa:artifact] runtime probe', input: { contract_version: '1.0', command_kind: 'message', stage_key: 'discover' } }),
  })).json();
  assert.equal(runtimeProbe.reply, 'Fixture reply · runtime probe');
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
  await page.getByRole('heading', { name: '创建第一个工作空间' }).waitFor();
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
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  record('read-only archive import and browser rendering');

  await page.getByLabel('工作空间名称').fill(`发行项目 ${suffix}`);
  await page.getByRole('button', { name: '创建工作空间' }).click();
  await page.getByTestId('workspace-slot').waitFor();
  assert.equal(await page.getByRole('dialog', { name: '阶段讨论' }).count(), 0);
  assert.equal(await page.getByText('当前浏览位置的未提交笔记').count(), 0);
  assert.equal(await page.getByText('派生路线').count(), 0);
  assert.equal(await page.getByText('generic_chat', { exact: true }).count(), 0);
  const sourceIds = currentIds();
  assert.match(sourceIds.routeId, /^[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: '推进实现' }).click();
  await page.getByRole('heading', { name: '推进实现' }).waitFor();
  assert.equal(currentIds().routeId, sourceIds.routeId);
  await page.getByRole('button', { name: '明确项目' }).click();
  await page.getByRole('heading', { name: '明确项目' }).waitFor();
  record('Stage-first Context workspace and free Stage browsing without cursor movement');

  await page.getByRole('button', { name: /打开讨论/ }).click();
  await page.getByRole('dialog', { name: '阶段讨论' }).waitFor();
  for (const title of [`方案讨论 ${suffix}`, `验证讨论 ${suffix}`]) {
    await page.getByRole('button', { name: '新建讨论', exact: true }).click();
    await page.getByLabel('讨论标题').fill(title);
    await page.getByRole('button', { name: '创建讨论' }).click();
    await page.getByRole('tab', { name: title }).waitFor();
  }
  const activeIds = currentIds();
  assert.match(activeIds.threadId, /^[0-9a-f-]{36}$/);
  record('two parallel discussions in one Stage drawer');

  const attachment = await page.evaluate(async ({ threadId, suffixValue }) => {
    const response = await fetch(`/api/threads/${threadId}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(`attachment-${suffixValue}.txt`), 'x-file-media-type': 'text/plain' },
      body: `attachment-${suffixValue}`,
    });
    return { status: response.status, body: await response.json() };
  }, { threadId: activeIds.threadId, suffixValue: suffix });
  assert.equal(attachment.status, 201);
  await page.locator('.attachment-panel').getByRole('button', { name: '刷新' }).click();
  await page.getByRole('link', { name: new RegExp(`attachment-${suffix}\\.txt`) }).waitFor();
  const artifactCommand = await sendUiMessage('[qa:artifact] release contract', 'Fixture reply · release contract');
  await page.locator('.proposal-row').filter({ hasText: 'qa_fact' }).getByRole('button', { name: '采纳' }).click();
  record('discussion attachment, Workflow Artifact proposal, and explicit memory proposal adoption');

  const replay = await browserJson(`/api/threads/${activeIds.threadId}/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(artifactCommand),
  });
  assert.equal(replay.status, 202);
  assert.equal(replay.body.commandId, artifactCommand.commandId);
  const mutatedReplay = await browserJson(`/api/threads/${activeIds.threadId}/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...artifactCommand, content: 'changed' }),
  });
  assert.equal(mutatedReplay.status, 409);
  record('command idempotency and mismatched replay rejection');

  await runNamedAction('采纳到当前路线', 'Fixture adopted thread');
  await page.getByRole('button', { name: '关闭讨论' }).click();
  await page.locator('.artifact-panel').getByRole('button', { name: '刷新' }).click();
  await page.getByRole('link', { name: /workflow-report\.txt/ }).waitFor();
  record('adopted discussion promotes its Workflow Artifact to a Stage outcome');

  await page.getByRole('button', { name: /打开讨论/ }).click();
  await runNamedAction('推进阶段', 'Fixture advanced to work');
  await waitFor('forward Stage projection', async () => /已完成/.test(await page.getByRole('button', { name: '明确项目' }).textContent() ?? ''));
  record('forward Stage transition and Checkpoint creation');

  const sourceWorkspace = await browserJson(`/api/routes/${sourceIds.routeId}/workspace?stage=discover`);
  const archivedCheckpoint = sourceWorkspace.body.checkpoints.find((checkpoint) => checkpoint.version === 0);
  const archivedCommand = await browserJson(`/api/threads/${activeIds.threadId}/commands`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      commandId: randomUUID(), kind: 'message', content: 'archived command must fail',
      baseCheckpointId: archivedCheckpoint.id, expectedCheckpointVersion: archivedCheckpoint.version,
    }),
  });
  assert.equal(archivedCommand.status, 409);
  assert.equal(archivedCommand.body.error.code, 'CHECKPOINT_NOT_CURRENT');
  record('archived versions reject Workflow commands');

  await page.getByRole('button', { name: '关闭讨论' }).click();
  await page.getByRole('button', { name: '版本', exact: true }).click();
  const versionDialog = page.getByRole('dialog', { name: '版本归档' });
  await versionDialog.waitFor();
  assert.equal(await versionDialog.getByLabel('消息内容').count(), 0);
  assert.equal(await versionDialog.getByRole('button', { name: '推进阶段' }).count(), 0);
  await versionDialog.getByRole('button', { name: /^版本 00/ }).click();
  await page.screenshot({ path: versionArchiveScreenshot, fullPage: true });
  report.screenshots.push(versionArchiveScreenshot);
  await versionDialog.getByRole('button', { name: '基于此版本新建路线' }).click();
  const versionRouteName = `归档方案 ${suffix}`;
  await versionDialog.getByLabel('新路线名称').fill(versionRouteName);
  await versionDialog.getByRole('button', { name: '创建路线', exact: true }).click();
  await page.waitForURL((url) => {
    const routeId = url.pathname.match(/\/routes\/([^/]+)/)?.[1];
    return Boolean(routeId && routeId !== sourceIds.routeId);
  });
  await page.getByRole('button', { name: versionRouteName, exact: true }).waitFor();
  await page.getByText(/^来源：.*\/ 版本 00$/).waitFor();
  assert.equal(await page.getByText('派生路线').count(), 0);
  await page.getByRole('button', { name: /打开讨论/ }).click();
  await page.getByRole('dialog', { name: '阶段讨论' }).waitFor();
  await page.getByRole('button', { name: '新建讨论', exact: true }).click();
  const versionDiscussionTitle = `版本路线讨论 ${suffix}`;
  await page.getByLabel('讨论标题').fill(versionDiscussionTitle);
  await page.getByRole('button', { name: '创建讨论' }).click();
  await page.getByRole('tab', { name: versionDiscussionTitle }).waitFor();
  const versionRouteIds = currentIds();
  assert.notEqual(versionRouteIds.routeId, sourceIds.routeId);
  assert.match(versionRouteIds.threadId, /^[0-9a-f-]{36}$/);
  record('read-only Version Archive creates an equal-status Route explicitly');

  const versionRouteWorkspace = await browserJson(`/api/routes/${versionRouteIds.routeId}/workspace?stage=discover`);
  const baseCheckpoint = versionRouteWorkspace.body.selectedCheckpoint;
  const concurrentBodies = [randomUUID(), randomUUID()].map((commandId) => ({
    commandId, kind: 'named_action', actionKey: 'adopt_thread', content: 'concurrent adopt',
    baseCheckpointId: baseCheckpoint.id, expectedCheckpointVersion: baseCheckpoint.version,
  }));
  const receipts = await Promise.all(concurrentBodies.map((body) => browserJson(`/api/threads/${versionRouteIds.threadId}/commands`, {
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
  assert.deepEqual(currentIds(), versionRouteIds);
  assert.equal(await page.getByRole('dialog', { name: '阶段讨论' }).count(), 0);
  record('refresh restores Route, Stage, and discussion URL state');

  await page.getByRole('button', { name: /打开讨论/ }).click();
  await page.getByRole('dialog', { name: '阶段讨论' }).waitFor();
  for (const [message, codeName] of [
    ['[qa:reject] command', 'WORKFLOW_REJECTED'],
    ['[qa:invalid] command', 'WORKFLOW_INVALID_RESPONSE'],
    ['[qa:timeout] command', 'WORKFLOW_TIMEOUT'],
  ]) {
    await page.getByLabel('消息内容').fill(message);
    await page.getByRole('button', { name: '发送消息' }).click();
    await page.getByRole('alert').filter({ hasText: codeName }).waitFor();
    await page.getByLabel('消息内容').fill('');
  }
  record('Workflow rejection, invalid result, and timeout fail closed');

  const createAdmin = run('docker', ['exec', webContainer, 'node', 'apps/api/dist/scripts/create-user.js',
    '--email', adminEmail, '--username', adminUsername, '--password', adminPassword, '--verified']);
  assert.match(createAdmin, /Created verified user/);
  await page.getByRole('button', { name: `${username} · 退出` }).click();
  await login(adminUsername, adminPassword, adminUsername);
  const isolated = await browserJson(`/api/routes/${sourceIds.routeId}/workspace?stage=discover`);
  assert.equal(isolated.status, 404);
  await page.getByRole('button', { name: `${adminUsername} · 退出` }).click();
  await login(username, password, username);
  await page.goto(`${appOrigin}/contexts/${versionRouteIds.contextId}/routes/${versionRouteIds.routeId}/stages/discover?thread=${versionRouteIds.threadId}`);
  await page.getByTestId('workspace-slot').waitFor();
  record('username login and cross-user isolation');

  assert.equal(await page.getByRole('dialog', { name: '阶段讨论' }).count(), 0);
  await page.screenshot({ path: desktopScreenshot, fullPage: true });
  report.screenshots.push(desktopScreenshot);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('workspace-slot').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 0, `mobile horizontal overflow: ${overflow}`);
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  report.screenshots.push(mobileScreenshot);
  await page.getByRole('button', { name: /打开讨论/ }).click();
  const mobileDrawer = page.getByRole('dialog', { name: '阶段讨论' });
  await mobileDrawer.waitFor();
  const drawerBounds = await mobileDrawer.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: Math.round(bounds.x), y: Math.round(bounds.y),
      width: Math.round(bounds.width), height: Math.round(bounds.height),
    };
  });
  assert.deepEqual(drawerBounds, { x: 0, y: 0, width: 390, height: 844 });
  await page.screenshot({ path: mobileDiscussionScreenshot });
  report.screenshots.push(mobileDiscussionScreenshot);
  await page.getByRole('button', { name: '关闭讨论' }).click();
  record('desktop Stage, Version Archive, mobile Stage, and full-screen mobile discussion screenshots');

  await runGovernedServiceAction(webServiceId, 'restart');
  await waitForHttp(`http://127.0.0.1:${webPort}/readyz`, { timeoutMs: 180_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('workspace-slot').waitFor();
  assert.deepEqual(currentIds(), versionRouteIds);
  const restoredAttachments = await browserJson(`/api/threads/${activeIds.threadId}/attachments`);
  assert.equal(restoredAttachments.status, 200);
  assert(restoredAttachments.body.attachments.some((asset) => asset.filename === `attachment-${suffix}.txt`));
  const restoredArtifacts = await browserJson(`/api/routes/${activeIds.routeId}/stages/${activeIds.stageKey}/artifacts`);
  assert.equal(restoredArtifacts.status, 200);
  const restoredArtifact = restoredArtifacts.body.artifacts.find((asset) => asset.filename === 'workflow-report.txt');
  assert(restoredArtifact);
  const restoredObject = await page.evaluate(async ({ kind, id }) => {
    const response = await fetch(`/api/assets/${kind}/${id}/download`);
    return { status: response.status, body: await response.text() };
  }, restoredArtifact);
  assert.deepEqual(restoredObject, { status: 200, body: 'artifact · release contract' });
  record('PolarProcess container restart preserves database, objects, session, and URL state');

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
