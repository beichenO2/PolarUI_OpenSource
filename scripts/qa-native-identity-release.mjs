import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { chromium } from '@playwright/test';
import { exportRelease } from './export-release.mjs';

const runId = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`.toLowerCase();
const root = mkdtempSync(join(tmpdir(), 'polar-native-identity-qa-'));
const artifactRoot = join(tmpdir(), `polar-native-identity-qa-artifacts-${runId}`);
const image = `polar-native-identity-qa:${runId}`;
const network = `polar-native-identity-qa-${runId}`;
const bundledProject = `polar-native-bundled-${runId}`;
const externalProject = `polar-native-external-${runId}`;
const externalPostgresContainer = `polar-native-external-postgres-${runId}`;
const postgresUser = 'polar';
const postgresDatabase = 'polar';
const postgresPassword = randomBytes(24).toString('base64url');
const authPepper = randomBytes(36).toString('base64url');
const suffix = randomBytes(6).toString('hex');
const email = `qa-${suffix}@example.test`;
const username = `qa_${suffix}`;
const password = `Qa-${randomBytes(12).toString('base64url')}`;
const adminEmail = `admin-${suffix}@example.test`;
const adminUsername = `admin_${suffix}`;
const adminPassword = `Admin-${randomBytes(12).toString('base64url')}`;
const externalEmail = `external-${suffix}@example.test`;
const externalUsername = `external_${suffix}`;
const externalPassword = `External-${randomBytes(12).toString('base64url')}`;
const contextTitle = `生产验证项目 ${suffix}`;
const secondContextTitle = `并行验证项目 ${suffix}`;
const firstThreadTitle = `方案怎么做 ${suffix}`;
const secondThreadTitle = `模版怎么改 ${suffix}`;
const branchName = `替代路线 ${suffix}`;
const draft = `未提交的生产验证草稿 ${suffix}`;
const firstMessage = `第一条生产消息 ${suffix}`;
const secondMessage = `第二条生产消息 ${suffix}`;
const interruptMessage = `需要人工确认 ${suffix}`;
const interruptReply = `采用权威来源 ${suffix}`;
const interruptPrompt = `请选择下一步采用的权威来源 ${suffix}`;
const resumedReply = `已按人工决定继续 ${suffix}`;
const failureMessage = `触发安全失败 ${suffix}`;
const slowMessage = `验证 SSE 断线续传 ${suffix}`;
const privateCursorToken = `private-${randomBytes(18).toString('base64url')}`;
const privateCursor = { token: privateCursorToken, step: 'awaiting_authority' };
const workflowRequests = [];
const workflowCallCounts = new Map();
const workflowServerErrors = [];
let protectedPath = '';
let sourceRouteId = '';
let sourceThreadId = '';
let derivedRouteId = '';
let derivedThreadId = '';

let browser;
let page;
let releasePath;
let tlsProxy;
let externalTlsProxy;
let workflowServer;
let mailpitProcess;
let bundledWebContainer;
let bundledPostgresContainer;
let externalWebContainer;
let bundledEnvironment;
let externalEnvironment;
let failed = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${options.label ?? `${command} failed`}${output ? `\n${output}` : ''}`);
  }
  return result.stdout.trim();
}

function docker(args, options = {}) {
  return run('docker', args, { ...options, label: options.label ?? `docker ${args[0]} failed` });
}

function compose({ project, file, args, environment }) {
  return docker([
    'compose', '--project-name', project, '-f', file, ...args,
  ], { env: environment, label: `docker compose ${project} failed` });
}

function psql(container, query, label = 'query PostgreSQL') {
  return docker([
    'exec', container,
    'psql', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', postgresUser, '-d', postgresDatabase,
    '-c', query,
  ], { label });
}

function psqlJson(container, query, label) {
  return JSON.parse(psql(container, query, label));
}

function trackedContainers() {
  return [bundledWebContainer, bundledPostgresContainer, externalWebContainer, externalPostgresContainer]
    .filter(Boolean);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(label, check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} timeout${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address === 'object');
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startTlsProxy({ port, targetPort, keyPath, certificatePath }) {
  return new Promise((resolve, reject) => {
    const server = createHttpsServer({
      key: readFileSync(keyPath),
      cert: readFileSync(certificatePath),
    }, (request, response) => {
      const upstream = httpRequest({
        hostname: '127.0.0.1',
        port: targetPort,
        method: request.method,
        path: request.url,
        headers: request.headers,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function startWorkflowServer(port) {
  const server = createHttpServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/run') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, reply: 'not found' }));
      return;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2_000_000) throw new Error('workflow request too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const commandId = body?.input?.command_id;
      assert.match(commandId, /^[0-9a-f-]{36}$/);
      assert.equal(request.headers['idempotency-key'], commandId);
      workflowRequests.push({ commandId, body });
      workflowCallCounts.set(commandId, (workflowCallCounts.get(commandId) ?? 0) + 1);

      if (body.message === slowMessage) await delay(900);
      let payload;
      if (body.input?.command_kind === 'resume_interrupt') {
        assert.equal(body.input.interrupt_id?.length > 0, true);
        assert.deepEqual(body.memoryPayload?.session?.polarflow_pending_run, privateCursor);
        assert.equal(body.message, interruptReply);
        payload = { ok: true, reply: resumedReply };
      } else if (body.message === interruptMessage) {
        payload = {
          ok: true,
          reply: interruptPrompt,
          memory_delta: { session: { polarflow_pending_run: privateCursor } },
        };
      } else if (body.message === failureMessage) {
        payload = { ok: false, reply: `请求已安全拒绝 ${suffix}` };
      } else if (body.input?.command_kind === 'named_action' && body.input?.named_action === 'advance') {
        payload = {
          ok: true,
          reply: `已推进到实现阶段 ${suffix}`,
          stage_signals: [
            { stage_key: 'discover', status: 'completed', internal_state: 'start' },
            { stage_key: 'work', status: 'active', internal_state: 'running' },
          ],
        };
      } else if (body.input?.command_kind === 'named_action' && body.input?.named_action === 'adopt_thread') {
        payload = { ok: true, reply: `已采纳线程到当前路线 ${suffix}` };
      } else {
        payload = { ok: true, reply: `Echo · ${body.message}` };
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(payload));
    } catch (error) {
      workflowServerErrors.push(error);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, reply: 'workflow QA server failed' }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

function workflowCalls(commandId) {
  return workflowCallCounts.get(commandId) ?? 0;
}

async function browserJson(url, init = {}) {
  return page.evaluate(async ({ target, requestInit }) => {
    const response = await fetch(target, requestInit);
    const body = await response.json().catch(() => null);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }, { target: url, requestInit: init });
}

async function readBrowserSse(eventUrl, { afterEventId = 0, stopAfterType } = {}) {
  return page.evaluate(async ({ target, cursor, stopType }) => {
    const response = await fetch(target, {
      headers: {
        accept: 'text/event-stream',
        ...(cursor > 0 ? { 'Last-Event-ID': String(cursor) } : {}),
      },
    });
    const headers = Object.fromEntries(response.headers.entries());
    if (!response.ok || !response.body) {
      return { status: response.status, headers, events: [], complete: false };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffer = '';
    let complete = false;
    while (!complete) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!frame || frame.startsWith(':')) continue;
        const fields = Object.fromEntries(frame.split(/\r?\n/).map((line) => {
          const separator = line.indexOf(':');
          return [line.slice(0, separator), line.slice(separator + 1).trimStart()];
        }));
        const event = { id: Number(fields.id), type: fields.event, payload: JSON.parse(fields.data) };
        events.push(event);
        if (event.type === stopType || event.type === 'command.finished') {
          complete = event.type === 'command.finished';
          await reader.cancel();
          return { status: response.status, headers, events, complete };
        }
      }
      if (chunk.done) break;
    }
    return { status: response.status, headers, events, complete };
  }, { target: eventUrl, cursor: afterEventId, stopType: stopAfterType ?? null });
}

function currentIds() {
  const url = new URL(page.url());
  return {
    contextId: url.pathname.match(/\/contexts\/([^/]+)/)?.[1] ?? '',
    routeId: url.pathname.match(/\/routes\/([^/]+)/)?.[1] ?? '',
    stageKey: url.pathname.match(/\/stages\/([^/]+)/)?.[1] ?? '',
    checkpointId: url.searchParams.get('checkpoint'),
    threadId: url.searchParams.get('thread'),
  };
}

async function assertNoHorizontalOverflow() {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert(dimensions.document <= dimensions.viewport, `document overflow: ${JSON.stringify(dimensions)}`);
  assert(dimensions.body <= dimensions.viewport, `body overflow: ${JSON.stringify(dimensions)}`);
}

function isCommandRequest(request, predicate) {
  if (request.method() !== 'POST' || !/\/api\/threads\/[0-9a-f-]+\/commands$/u.test(request.url())) return false;
  try {
    return predicate(request.postDataJSON());
  } catch {
    return false;
  }
}

async function sendConversationMessage(content, expectedReply) {
  const requestPromise = page.waitForRequest((request) =>
    isCommandRequest(request, (body) => body.kind === 'message' && body.content === content));
  await page.getByLabel('消息内容').fill(content);
  await page.getByRole('button', { name: '发送消息' }).click();
  const request = await requestPromise;
  await page.locator('.message-timeline').getByText(expectedReply, { exact: true }).waitFor();
  return request.postDataJSON();
}

async function runNamedAction(label, actionKey, expectedReply) {
  const requestPromise = page.waitForRequest((request) =>
    isCommandRequest(request, (body) => body.kind === 'named_action' && body.actionKey === actionKey));
  await page.getByRole('button', { name: label, exact: true }).click();
  const request = await requestPromise;
  await page.locator('.message-timeline').getByText(expectedReply, { exact: true }).waitFor();
  return request.postDataJSON();
}

async function waitForHttp(url, label, timeoutMs = 90_000) {
  return waitFor(label, async () => {
    const response = await fetch(url);
    return response.ok ? response : false;
  }, { timeoutMs });
}

async function extractVerificationCode(mailpitOrigin, recipient) {
  return waitFor('verification email', async () => {
    const response = await fetch(`${mailpitOrigin}/api/v1/messages`);
    if (!response.ok) return false;
    const body = await response.json();
    const messages = body.messages ?? body.Messages ?? [];
    for (const summary of messages) {
      if (!JSON.stringify(summary).toLowerCase().includes(recipient.toLowerCase())) continue;
      const id = summary.ID ?? summary.Id ?? summary.id;
      if (!id) continue;
      const detailResponse = await fetch(`${mailpitOrigin}/api/v1/message/${encodeURIComponent(id)}`);
      if (!detailResponse.ok) continue;
      const detail = await detailResponse.json();
      const content = [detail.Text, detail.HTML, detail.text, detail.html, JSON.stringify(detail)]
        .filter(Boolean)
        .join('\n');
      const contextual = content.match(/验证码[^0-9]{0,40}(\d{6})/u);
      const fallback = content.match(/\b(\d{6})\b/u);
      if (contextual || fallback) return (contextual ?? fallback)[1];
    }
    return false;
  }, { timeoutMs: 30_000, intervalMs: 300 });
}

function startMailpit({ httpPort, smtpPort }) {
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!platform || !architecture) throw new Error(`unsupported Mailpit QA host: ${process.platform}/${process.arch}`);
  const archive = join(root, 'mailpit.tar.gz');
  const binary = join(root, 'mailpit');
  run('curl', [
    '-fsSL',
    `https://github.com/axllent/mailpit/releases/download/v1.27.0/mailpit-${platform}-${architecture}.tar.gz`,
    '-o', archive,
  ], { label: 'download Mailpit release' });
  run('tar', ['-xzf', archive, '-C', root, 'mailpit'], { label: 'extract Mailpit release' });
  const logPath = join(root, 'mailpit.log');
  const child = spawn(binary, [
    '--listen', `127.0.0.1:${httpPort}`,
    '--smtp', `0.0.0.0:${smtpPort}`,
    '--disable-version-check',
    '--log-file', logPath,
  ], { stdio: 'ignore' });
  child.unref();
  return child;
}

async function fillLogin(identifier, loginPassword) {
  await page.getByLabel('邮箱或用户名').fill(identifier);
  await page.getByLabel('密码').fill(loginPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

function runtimeReleaseFiles(rootPath) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(rootPath);
  return files;
}

function assertNoLegacyRuntime() {
  const files = runtimeReleaseFiles(releasePath);
  const forbidden = /librechat|mongodb|mongoose/i;
  const forbiddenPaths = files
    .map((path) => relative(releasePath, path))
    .filter((path) => forbidden.test(path));
  assert.deepEqual(forbiddenPaths, [], `forbidden native release paths: ${forbiddenPaths.join(', ')}`);

  const runtimeFiles = files.filter((path) =>
    /(?:^|\/)(?:package(?:-lock)?\.json|Dockerfile|compose(?:\.external-db)?\.yml|\.env\.example)$/u
      .test(relative(releasePath, path)));
  for (const path of runtimeFiles) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      forbidden,
      `forbidden native runtime dependency in ${relative(releasePath, path)}`,
    );
  }

  for (const name of trackedContainers()) {
    const inspection = docker(['inspect', '--format', '{{.Name}} {{.Config.Image}}', name]);
    assert.doesNotMatch(inspection, forbidden, `forbidden runtime in ${name}`);
  }
  assert.doesNotMatch(docker(['image', 'inspect', '--format', '{{json .RepoTags}}', image]), forbidden);
}

async function preserveFailure(error) {
  try {
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(join(artifactRoot, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
    writeFileSync(join(artifactRoot, 'workflow-requests.json'), JSON.stringify(workflowRequests, null, 2));
    writeFileSync(join(artifactRoot, 'workflow-server-errors.txt'), workflowServerErrors.map((item) =>
      item instanceof Error ? item.stack ?? item.message : String(item)).join('\n\n'));
    if (page) {
      await page.screenshot({ path: join(artifactRoot, 'browser.png'), fullPage: true }).catch(() => {});
      writeFileSync(join(artifactRoot, 'browser-url.txt'), page.url());
    }
    for (const name of trackedContainers()) {
      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (logs.status === 0) {
        writeFileSync(join(artifactRoot, `${basename(name)}.log`), `${logs.stdout ?? ''}${logs.stderr ?? ''}`);
      }
    }
    if (releasePath && existsSync(releasePath)) {
      for (const file of ['site.manifest.json', 'product.manifest.json', 'compose.yml', 'compose.external-db.yml']) {
        const source = join(releasePath, file);
        if (existsSync(source)) writeFileSync(join(artifactRoot, file), readFileSync(source));
      }
    }
    process.stderr.write(`QA failure artifacts: ${artifactRoot}\n`);
  } catch {
    // Artifact collection must never prevent resource cleanup.
  }
}

try {
  const [
    webPort,
    webBackendPort,
    mailpitPort,
    mailpitSmtpPort,
    externalWebPort,
    externalPublicPort,
    workflowPort,
  ] = await Promise.all([
    allocateLoopbackPort(),
    allocateLoopbackPort(),
    allocateLoopbackPort(),
    allocateLoopbackPort(),
    allocateLoopbackPort(),
    allocateLoopbackPort(),
    allocateLoopbackPort(),
  ]);
  assert.equal(new Set([
    webPort,
    webBackendPort,
    mailpitPort,
    mailpitSmtpPort,
    externalWebPort,
    externalPublicPort,
    workflowPort,
  ]).size, 7);
  const appOrigin = `https://127.0.0.1:${webPort}`;
  const webBackendOrigin = `http://127.0.0.1:${webBackendPort}`;
  const mailpitOrigin = `http://127.0.0.1:${mailpitPort}`;
  const externalBackendOrigin = `http://127.0.0.1:${externalWebPort}`;
  const externalOrigin = `https://127.0.0.1:${externalPublicPort}`;
  const workflowEndpoint = `http://host.docker.internal:${workflowPort}/run`;
  const externalDatabaseUrl = `postgresql://${postgresUser}:${postgresPassword}@external-postgres:5432/${postgresDatabase}`;

  workflowServer = await startWorkflowServer(workflowPort);

  const exported = await exportRelease({
    workflow: 'claude-code',
    webRoot: root,
    templateFlavor: 'native',
    skipPreflight: true,
    compileOnly: true,
    silent: true,
  });
  if (!exported.ok) throw new Error(`native export failed: ${JSON.stringify(exported)}`);
  releasePath = exported.release_path;

  docker(['network', 'create', network], { label: 'create QA network' });
  docker([
    'run', '--rm', '-d',
    '--name', externalPostgresContainer,
    '--network', network,
    '--network-alias', 'external-postgres',
    '-e', `POSTGRES_DB=${postgresDatabase}`,
    '-e', `POSTGRES_USER=${postgresUser}`,
    '-e', `POSTGRES_PASSWORD=${postgresPassword}`,
    'postgres:16-alpine',
  ], { label: 'start PostgreSQL' });
  const externalPostgresPorts = JSON.parse(docker([
    'inspect', '--format', '{{json .HostConfig.PortBindings}}', externalPostgresContainer,
  ]) || 'null');
  assert(!externalPostgresPorts || !externalPostgresPorts['5432/tcp'], 'external PostgreSQL must not publish a host port');
  await waitFor('external PostgreSQL readiness', () => {
    const result = spawnSync('docker', [
      'exec', externalPostgresContainer, 'pg_isready', '-U', postgresUser, '-d', postgresDatabase,
    ], { stdio: 'ignore' });
    return result.status === 0;
  });

  mailpitProcess = startMailpit({ httpPort: mailpitPort, smtpPort: mailpitSmtpPort });
  await waitForHttp(`${mailpitOrigin}/api/v1/messages`, 'Mailpit HTTP API');

  const tlsKeyPath = join(root, 'qa-tls-key.pem');
  const tlsCertificatePath = join(root, 'qa-tls-certificate.pem');
  run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', tlsKeyPath,
    '-out', tlsCertificatePath,
    '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { label: 'generate loopback QA TLS certificate' });
  tlsProxy = await startTlsProxy({
    port: webPort,
    targetPort: webBackendPort,
    keyPath: tlsKeyPath,
    certificatePath: tlsCertificatePath,
  });
  externalTlsProxy = await startTlsProxy({
    port: externalPublicPort,
    targetPort: externalWebPort,
    keyPath: tlsKeyPath,
    certificatePath: tlsCertificatePath,
  });
  const bundledComposeFile = join(releasePath, 'compose.yml');
  bundledEnvironment = {
    ...process.env,
    POLAR_NATIVE_IMAGE: image,
    POLAR_WEB_BIND: '127.0.0.1',
    POLAR_WEB_PORT: String(webBackendPort),
    POSTGRES_DB: postgresDatabase,
    POSTGRES_USER: postgresUser,
    POSTGRES_PASSWORD: postgresPassword,
    AUTH_PEPPER: authPepper,
    PUBLIC_APP_ORIGIN: appOrigin,
    COOKIE_SECURE: 'true',
    SMTP_HOST: 'host.docker.internal',
    SMTP_PORT: String(mailpitSmtpPort),
    SMTP_FROM: 'Polar Workflow <no-reply@example.test>',
    SMTP_SECURE: 'false',
    WORKFLOW_ENDPOINT_OVERRIDE: workflowEndpoint,
    WORKFLOW_TIMEOUT_MS: '5000',
  };
  compose({
    project: bundledProject,
    file: bundledComposeFile,
    args: ['up', '--build', '-d', 'web'],
    environment: bundledEnvironment,
  });
  bundledWebContainer = compose({
    project: bundledProject, file: bundledComposeFile, args: ['ps', '-q', 'web'], environment: bundledEnvironment,
  });
  bundledPostgresContainer = compose({
    project: bundledProject, file: bundledComposeFile, args: ['ps', '-q', 'postgres'], environment: bundledEnvironment,
  });
  assert(bundledWebContainer && bundledPostgresContainer, 'bundled Compose containers must exist');
  const bundledPostgresPorts = JSON.parse(docker([
    'inspect', '--format', '{{json .HostConfig.PortBindings}}', bundledPostgresContainer,
  ]) || 'null');
  assert(!bundledPostgresPorts || !bundledPostgresPorts['5432/tcp'], 'bundled PostgreSQL must not publish a host port');
  await waitForHttp(`${webBackendOrigin}/readyz`, 'native Web readiness', 120_000);

  browser = await chromium.launch();
  page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await page.goto(`${appOrigin}/register`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '创建工作区账号' }).waitFor();
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '注册并发送验证码' }).click();
  await page.getByRole('heading', { name: '验证邮箱' }).waitFor();

  const unverifiedLogin = await page.evaluate(async ({ identifier, loginPassword }) => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password: loginPassword }),
    });
    return { status: response.status, body: await response.json() };
  }, { identifier: email, loginPassword: password });
  assert.equal(unverifiedLogin.status, 401);
  assert.equal(unverifiedLogin.body?.error?.code, 'INVALID_CREDENTIALS');

  const code = await extractVerificationCode(mailpitOrigin, email);
  assert.match(code, /^\d{6}$/);
  await page.getByLabel('六位验证码').fill(code);
  await page.getByRole('button', { name: '完成验证' }).click();
  await page.getByRole('heading', { name: '重新进入工作区' }).waitFor();

  await fillLogin(email, password);
  await page.getByRole('heading', { name: '创建第一个项目' }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '创建第一个项目' }).waitFor();
  await page.getByRole('button', { name: `${username} · 退出` }).click();
  await page.getByRole('heading', { name: '重新进入工作区' }).waitFor();

  await fillLogin(username, password);
  await page.getByRole('heading', { name: '创建第一个项目' }).waitFor();
  await page.getByLabel('项目名称').fill(contextTitle);
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByTestId('workspace-slot').waitFor();
  await page.getByRole('heading', { name: '明确项目' }).waitFor();
  await page.getByRole('button', { name: '新建项目' }).click();
  await page.getByLabel('项目名称').fill(secondContextTitle);
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByRole('button', { name: new RegExp(`${secondContextTitle}.*当前问题空间`) }).waitFor();
  const secondContextRouteId = currentIds().routeId;
  await Promise.all([
    page.waitForURL((url) => {
      const routeId = url.pathname.match(/\/routes\/([^/]+)/)?.[1];
      return Boolean(routeId && routeId !== secondContextRouteId);
    }),
    page.getByRole('button', { name: new RegExp(`${contextTitle}.*切换进入`) }).click(),
  ]);
  await page.getByRole('heading', { name: '明确项目' }).waitFor();
  sourceRouteId = new URL(page.url()).pathname.match(/\/routes\/([^/]+)\//)?.[1] ?? '';
  assert.match(sourceRouteId, /^[0-9a-f-]{36}$/);

  const sourceBootstrapWorkspace = await browserJson(`/api/routes/${sourceRouteId}/workspace?stage=discover`);
  assert.equal(sourceBootstrapWorkspace.status, 200);
  const sourceCheckpointId = sourceBootstrapWorkspace.body.selectedCheckpoint.id;
  assert.equal(sourceBootstrapWorkspace.body.selectedCheckpoint.version, 0);
  const sourceCheckpointBefore = psql(
    bundledPostgresContainer,
    `SELECT row_to_json(row_data)::text FROM (
      SELECT id, context_id, route_id, parent_checkpoint_id, version, stage_key, reason, snapshot, created_at
      FROM workflow_checkpoints WHERE id = '${sourceCheckpointId}'::uuid
    ) row_data;`,
    'capture immutable source checkpoint',
  );

  await page.getByRole('button', { name: '从此检查点创建新路线' }).click();
  await page.getByLabel('新路线名称').fill(branchName);
  await page.getByRole('button', { name: '创建路线' }).click();
  await page.getByRole('button', { name: branchName }).waitFor();
  await page.getByText('源自检查点 00').waitFor();
  const manualBranchRouteId = currentIds().routeId;
  assert.match(manualBranchRouteId, /^[0-9a-f-]{36}$/);
  assert.notEqual(manualBranchRouteId, sourceRouteId);
  await Promise.all([
    page.waitForURL((url) => url.pathname.includes(`/routes/${sourceRouteId}/`)),
    page.getByRole('button', { name: '主线', exact: true }).click(),
  ]);
  await page.getByRole('heading', { name: '明确项目' }).waitFor();

  for (const title of [firstThreadTitle, secondThreadTitle]) {
    await page.getByRole('button', { name: '新建线程', exact: true }).click();
    await page.getByLabel('线程标题').fill(title);
    await page.getByRole('button', { name: '创建线程' }).click();
    await page.getByRole('button', { name: title }).waitFor();
  }
  sourceThreadId = currentIds().threadId ?? '';
  assert.match(sourceThreadId, /^[0-9a-f-]{36}$/);
  protectedPath = new URL(page.url()).pathname + new URL(page.url()).search;
  assert.match(protectedPath, new RegExp(`/routes/${sourceRouteId}/stages/discover\\?thread=${sourceThreadId}`));
  await page.getByLabel('阶段草稿').fill(draft);
  assert.equal(await page.getByLabel('阶段草稿').inputValue(), draft);

  const revoked = docker([
    'exec', bundledPostgresContainer,
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', postgresUser, '-d', postgresDatabase,
    '-c', `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = (SELECT id FROM users WHERE email_normalized = '${email}') AND revoked_at IS NULL;`,
  ], { label: 'revoke browser session' });
  assert.match(revoked, /UPDATE 1$/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '重新进入工作区' }).waitFor();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, protectedPath);

  await fillLogin(username, password);
  await page.getByTestId('workspace-slot').waitFor();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, protectedPath);
  assert.equal(await page.getByLabel('阶段草稿').inputValue(), draft);

  await assertNoHorizontalOverflow();
  const firstCommand = await sendConversationMessage(firstMessage, `Echo · ${firstMessage}`);
  const secondCommand = await sendConversationMessage(secondMessage, `Echo · ${secondMessage}`);
  assert.equal(workflowCalls(firstCommand.commandId), 1);
  assert.equal(workflowCalls(secondCommand.commandId), 1);

  const interruptCommand = await sendConversationMessage(interruptMessage, interruptPrompt);
  await page.locator('.interrupt-panel').getByText(interruptPrompt, { exact: true }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.interrupt-panel').getByText(interruptPrompt, { exact: true }).waitFor();
  const publicInterruptState = await browserJson(`/api/threads/${sourceThreadId}/messages`);
  assert.equal(publicInterruptState.status, 200);
  assert.equal(publicInterruptState.body.pendingInterrupt.prompt, interruptPrompt);
  assert.doesNotMatch(JSON.stringify(publicInterruptState.body), new RegExp(privateCursorToken));
  assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(privateCursorToken));
  const interruptId = publicInterruptState.body.pendingInterrupt.id;
  assert.match(interruptId, /^[0-9a-f-]{36}$/);

  const resumeRequestPromise = page.waitForRequest((request) =>
    isCommandRequest(request, (body) => body.kind === 'resume_interrupt' && body.interruptId === interruptId));
  await page.getByLabel('中断回复').fill(interruptReply);
  await page.getByRole('button', { name: '继续工作流' }).click();
  const resumeCommand = (await resumeRequestPromise).postDataJSON();
  await page.getByText(resumedReply, { exact: true }).waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('.interrupt-panel').count(), 0);
  const resolvedInterruptState = await browserJson(`/api/threads/${sourceThreadId}/messages`);
  assert.equal(resolvedInterruptState.body.pendingInterrupt, null);
  assert.doesNotMatch(JSON.stringify(resolvedInterruptState.body), new RegExp(privateCursorToken));
  assert.equal(workflowCalls(interruptCommand.commandId), 1);
  assert.equal(workflowCalls(resumeCommand.commandId), 1);

  const failureRequestPromise = page.waitForRequest((request) =>
    isCommandRequest(request, (body) => body.kind === 'message' && body.content === failureMessage));
  await page.getByLabel('消息内容').fill(failureMessage);
  await page.getByRole('button', { name: '发送消息' }).click();
  const failedCommand = (await failureRequestPromise).postDataJSON();
  await page.getByRole('alert').filter({ hasText: 'WORKFLOW_REJECTED' }).waitFor();
  assert.equal(await page.getByLabel('消息内容').inputValue(), failureMessage);
  await page.getByLabel('消息内容').fill('');
  assert.equal(workflowCalls(failedCommand.commandId), 1);

  const adoptReply = `已采纳线程到当前路线 ${suffix}`;
  const adoptCommand = await runNamedAction('采纳到当前路线', 'adopt_thread', adoptReply);
  assert.match(adoptCommand.content, /\S/u, 'named actions must persist non-empty command content');
  const adoptCallsBeforeReplay = workflowCalls(adoptCommand.commandId);
  assert.equal(adoptCallsBeforeReplay, 1);
  const replayReceipt = await browserJson(`/api/threads/${sourceThreadId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(adoptCommand),
  });
  assert.equal(replayReceipt.status, 202);
  assert.equal(replayReceipt.body.commandId, adoptCommand.commandId);
  const replayEvents = await readBrowserSse(replayReceipt.body.eventUrl);
  assert.equal(replayEvents.status, 200);
  assert.equal(replayEvents.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(replayEvents.headers['x-accel-buffering'], 'no');
  assert.deepEqual(replayEvents.events.map((event) => event.type), [
    'command.accepted',
    'workflow.started',
    'assistant.delta',
    'workspace.committed',
    'command.finished',
  ]);
  assert.equal(replayEvents.events.at(-1)?.payload?.outcome, 'succeeded');
  assert.equal(workflowCalls(adoptCommand.commandId), adoptCallsBeforeReplay);

  const advanceReply = `已推进到实现阶段 ${suffix}`;
  const advanceCommand = await runNamedAction('推进阶段', 'advance', advanceReply);
  await waitFor('forward Stage projections', async () => {
    const discoverText = await page.getByRole('button', { name: '明确项目' }).textContent();
    const workText = await page.getByRole('button', { name: '推进实现' }).textContent();
    return /已完成/.test(discoverText ?? '') && /进行中/.test(workText ?? '');
  });
  assert.equal(workflowCalls(advanceCommand.commandId), 1);

  const currentWorkspace = await browserJson(`/api/routes/${sourceRouteId}/workspace?stage=discover`);
  assert.equal(currentWorkspace.status, 200);
  assert.equal(currentWorkspace.body.selectedCheckpoint.version, 2);
  const slowCommandId = randomUUID();
  const slowCommand = {
    commandId: slowCommandId,
    kind: 'message',
    content: slowMessage,
    baseCheckpointId: currentWorkspace.body.selectedCheckpoint.id,
    expectedCheckpointVersion: currentWorkspace.body.selectedCheckpoint.version,
  };
  const slowReceipt = await browserJson(`/api/threads/${sourceThreadId}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(slowCommand),
  });
  assert.equal(slowReceipt.status, 202);
  const droppedStream = await readBrowserSse(slowReceipt.body.eventUrl, { stopAfterType: 'workflow.started' });
  assert.equal(droppedStream.status, 200);
  assert.equal(droppedStream.complete, false);
  assert.equal(droppedStream.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(droppedStream.headers['x-accel-buffering'], 'no');
  assert.deepEqual(droppedStream.events.map((event) => [event.id, event.type]), [
    [1, 'command.accepted'],
    [2, 'workflow.started'],
  ]);
  const reconnectedStream = await readBrowserSse(slowReceipt.body.eventUrl, { afterEventId: 2 });
  assert.equal(reconnectedStream.complete, true);
  assert.deepEqual(reconnectedStream.events.map((event) => [event.id, event.type]), [
    [3, 'assistant.delta'],
    [4, 'workspace.committed'],
    [5, 'command.finished'],
  ]);
  assert.equal(reconnectedStream.events.at(-1)?.payload?.outcome, 'succeeded');
  assert.equal(workflowCalls(slowCommandId), 1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(`Echo · ${slowMessage}`, { exact: true }).waitFor();

  await page.getByRole('button', { name: /^检查点 00/ }).click();
  await page.getByRole('status').filter({ hasText: '正在浏览历史检查点 00' }).waitFor();
  assert.match(await page.getByRole('button', { name: '明确项目' }).textContent(), /进行中/);
  assert.match(await page.getByRole('button', { name: '推进实现' }).textContent(), /可提前讨论/);
  const historicalRequestPromise = page.waitForRequest((request) =>
    isCommandRequest(request, (body) => body.kind === 'named_action' && body.actionKey === 'adopt_thread'));
  await page.getByRole('button', { name: '采纳到当前路线', exact: true }).click();
  const historicalCommand = (await historicalRequestPromise).postDataJSON();
  await page.waitForURL((url) => {
    const routeId = url.pathname.match(/\/routes\/([^/]+)/)?.[1];
    return Boolean(routeId && routeId !== sourceRouteId && url.searchParams.get('thread') !== sourceThreadId);
  });
  derivedRouteId = currentIds().routeId;
  derivedThreadId = currentIds().threadId ?? '';
  assert.match(derivedRouteId, /^[0-9a-f-]{36}$/);
  assert.match(derivedThreadId, /^[0-9a-f-]{36}$/);
  assert.notEqual(derivedRouteId, sourceRouteId);
  assert.notEqual(derivedThreadId, sourceThreadId);
  await page.getByRole('button', { name: '派生路线 0', exact: true }).waitFor();
  await page.getByRole('button', { name: '派生讨论 discover', exact: true }).waitFor();
  await page.getByText('源自检查点 00').waitFor();
  await page.getByText(adoptReply, { exact: true }).waitFor();
  assert.equal(workflowCalls(historicalCommand.commandId), 1);

  const exactCounts = psqlJson(bundledPostgresContainer, `SELECT json_build_object(
    'contexts', (SELECT count(*) FROM contexts),
    'routes', (SELECT count(*) FROM workflow_routes),
    'threads', (SELECT count(*) FROM workflow_threads),
    'checkpoints', (SELECT count(*) FROM workflow_checkpoints),
    'commands', (SELECT count(*) FROM workflow_commands),
    'messages', (SELECT count(*) FROM workflow_messages),
    'events', (SELECT count(*) FROM workflow_command_events),
    'interrupts', (SELECT count(*) FROM workflow_interrupts)
  );`, 'inspect exact native command persistence');
  assert.deepEqual(exactCounts, {
    contexts: 2,
    routes: 4,
    threads: 3,
    checkpoints: 6,
    commands: 9,
    messages: 16,
    events: 43,
    interrupts: 1,
  });

  const successfulCommandIds = [
    firstCommand.commandId,
    secondCommand.commandId,
    interruptCommand.commandId,
    resumeCommand.commandId,
    adoptCommand.commandId,
    advanceCommand.commandId,
    slowCommandId,
    historicalCommand.commandId,
  ];
  const orderedEvents = psqlJson(bundledPostgresContainer, `SELECT COALESCE(json_object_agg(command_id, event_types), '{}'::json)
    FROM (
      SELECT command_id::text,
        json_agg(event_type ORDER BY sequence) AS event_types
      FROM workflow_command_events GROUP BY command_id
    ) event_order;`, 'inspect ordered command events');
  const successEventTypes = [
    'command.accepted',
    'workflow.started',
    'assistant.delta',
    'workspace.committed',
    'command.finished',
  ];
  for (const commandId of successfulCommandIds) assert.deepEqual(orderedEvents[commandId], successEventTypes);
  assert.deepEqual(orderedEvents[failedCommand.commandId], [
    'command.accepted',
    'workflow.started',
    'command.finished',
  ]);
  assert.equal(psql(
    bundledPostgresContainer,
    `SELECT status || '|' || error_code FROM workflow_commands WHERE id = '${failedCommand.commandId}'::uuid;`,
    'inspect safe workflow failure',
  ), 'failed|WORKFLOW_REJECTED');
  assert.equal(psql(
    bundledPostgresContainer,
    `SELECT status || '|' || resolution_command_id::text || '|' || (workflow_cursor->>'token')
      FROM workflow_interrupts WHERE id = '${interruptId}'::uuid;`,
    'inspect resolved private workflow interrupt',
  ), `resolved|${resumeCommand.commandId}|${privateCursorToken}`);
  assert.equal(psql(
    bundledPostgresContainer,
    `SELECT count(*) FROM workflow_commands WHERE kind = 'resume_interrupt' AND interrupt_id = '${interruptId}'::uuid;`,
    'inspect single interrupt resume',
  ), '1');
  assert.equal(workflowRequests.filter((item) => item.body.input.command_kind === 'resume_interrupt').length, 1);
  assert.equal(workflowRequests.length, 9);
  assert.equal(workflowServerErrors.length, 0, workflowServerErrors.map(String).join('\n'));

  const sourceCheckpointAfter = psql(
    bundledPostgresContainer,
    `SELECT row_to_json(row_data)::text FROM (
      SELECT id, context_id, route_id, parent_checkpoint_id, version, stage_key, reason, snapshot, created_at
      FROM workflow_checkpoints WHERE id = '${sourceCheckpointId}'::uuid
    ) row_data;`,
    'verify immutable source checkpoint',
  );
  assert.equal(sourceCheckpointAfter, sourceCheckpointBefore);
  assert.equal(psql(
    bundledPostgresContainer,
    `SELECT string_agg(version::text || ':' || reason, ',' ORDER BY version)
      FROM workflow_checkpoints WHERE route_id = '${sourceRouteId}'::uuid;`,
    'inspect source checkpoint lineage',
  ), '0:bootstrap,1:workflow_action,2:workflow_action');
  assert.equal(psql(
    bundledPostgresContainer,
    `SELECT r.origin_checkpoint_id::text || '|' || t.origin_thread_id::text || '|' || cp.version::text || '|' || cp.reason
      FROM workflow_routes r
      JOIN workflow_threads t ON t.route_id = r.id
      JOIN workflow_checkpoints cp ON cp.id = r.head_checkpoint_id
      WHERE r.id = '${derivedRouteId}'::uuid AND t.id = '${derivedThreadId}'::uuid;`,
    'inspect derived route and thread lineage',
  ), `${sourceCheckpointId}|${sourceThreadId}|0|workflow_action`);
  assert.equal(psql(
    bundledPostgresContainer,
    `SELECT result_route_id::text || '|' || result_thread_id::text || '|' || result_checkpoint_id::text
      FROM workflow_commands WHERE id = '${historicalCommand.commandId}'::uuid;`,
    'inspect historical command result',
  ).split('|').slice(0, 2).join('|'), `${derivedRouteId}|${derivedThreadId}`);
  const immutableProbe = spawnSync('docker', [
    'exec', bundledPostgresContainer,
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', postgresUser, '-d', postgresDatabase,
    '-c', `UPDATE workflow_checkpoints SET reason = 'workflow_action' WHERE id = '${sourceCheckpointId}'::uuid;`,
  ], { encoding: 'utf8' });
  assert.notEqual(immutableProbe.status, 0, 'checkpoint mutation must fail');
  assert.match(`${immutableProbe.stdout ?? ''}${immutableProbe.stderr ?? ''}`, /checkpoints are immutable/i);

  protectedPath = new URL(page.url()).pathname + new URL(page.url()).search;
  assert.match(protectedPath, new RegExp(`/routes/${derivedRouteId}/stages/discover\\?thread=${derivedThreadId}`));

  const volumeName = `${bundledProject}_polar_postgres_data`;
  const volumeBefore = JSON.parse(docker(['volume', 'inspect', volumeName]))[0]?.Name;
  compose({
    project: bundledProject,
    file: bundledComposeFile,
    args: ['up', '-d', '--no-deps', '--force-recreate', 'web'],
    environment: bundledEnvironment,
  });
  bundledWebContainer = compose({
    project: bundledProject, file: bundledComposeFile, args: ['ps', '-q', 'web'], environment: bundledEnvironment,
  });
  const volumeAfter = JSON.parse(docker(['volume', 'inspect', volumeName]))[0]?.Name;
  assert.equal(volumeAfter, volumeBefore, 'bundled PostgreSQL volume must survive Web replacement');
  await waitForHttp(`${webBackendOrigin}/readyz`, 'native Web replacement readiness', 120_000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('workspace-slot').waitFor();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, protectedPath);
  await page.getByRole('button', { name: '派生讨论 discover', exact: true }).waitFor();
  assert.match(await page.getByRole('button', { name: '派生讨论 discover', exact: true }).getAttribute('class'), /active-thread/);
  await page.getByText(adoptReply, { exact: true }).waitFor();
  await page.getByRole('button', { name: branchName }).waitFor();

  const adminResult = compose({
    project: bundledProject,
    file: bundledComposeFile,
    environment: bundledEnvironment,
    args: ['exec', '-T', 'web', 'npm', 'run', 'user:create', '--',
    '--email', adminEmail,
    '--username', adminUsername,
    '--password', adminPassword,
    '--verified',
  ] });
  assert.match(adminResult, new RegExp(`Created verified user: ${adminUsername}$`));
  await page.getByRole('button', { name: `${username} · 退出` }).click();
  await page.getByRole('heading', { name: '重新进入工作区' }).waitFor();
  await fillLogin(adminUsername, adminPassword);
  await page.getByRole('button', { name: `${adminUsername} · 退出` }).waitFor();
  const crossUser = await browserJson(`/api/routes/${sourceRouteId}/workspace?stage=discover`);
  assert.equal(crossUser.status, 404);
  assert.equal(crossUser.body?.error?.code, 'NOT_FOUND');
  const crossUserMessages = await browserJson(`/api/threads/${sourceThreadId}/messages`);
  assert.equal(crossUserMessages.status, 404);
  assert.equal(crossUserMessages.body?.error?.code, 'NOT_FOUND');
  const crossUserEvents = await browserJson(`/api/commands/${firstCommand.commandId}/events`);
  assert.equal(crossUserEvents.status, 404);
  assert.equal(crossUserEvents.body?.error?.code, 'NOT_FOUND');
  await page.getByRole('button', { name: `${adminUsername} · 退出` }).click();
  await page.getByRole('heading', { name: '重新进入工作区' }).waitFor();
  await fillLogin(username, password);
  await page.getByTestId('workspace-slot').waitFor();
  await page.goto(`${appOrigin}${protectedPath}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '派生讨论 discover', exact: true }).waitFor();
  await page.getByText(adoptReply, { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('product-bar').waitFor();
  await page.getByTestId('workspace-slot').waitFor();
  await page.getByText(adoptReply, { exact: true }).waitFor();
  assert.match(await page.getByRole('button', { name: '派生讨论 discover', exact: true }).getAttribute('class'), /active-thread/);
  await assertNoHorizontalOverflow();
  assert.equal(await page.getByText(/LibreChat/i).count(), 0);
  assert.equal(await page.getByText(/MongoDB|Mongo/i).count(), 0);

  const externalOverride = join(root, 'compose.external.qa.yml');
  writeFileSync(externalOverride, `services:\n  web:\n    network_mode: ${network}\n`);
  const externalComposeFile = join(releasePath, 'compose.external-db.yml');
  externalEnvironment = {
    ...process.env,
    POLAR_NATIVE_IMAGE: image,
    POLAR_WEB_BIND: '127.0.0.1',
    POLAR_WEB_PORT: String(externalWebPort),
    DATABASE_URL: externalDatabaseUrl,
    AUTH_PEPPER: authPepper,
    PUBLIC_APP_ORIGIN: externalOrigin,
    COOKIE_SECURE: 'true',
    SMTP_HOST: 'host.docker.internal',
    SMTP_PORT: String(mailpitSmtpPort),
    SMTP_FROM: 'Polar Workflow <no-reply@example.test>',
    SMTP_SECURE: 'false',
    WORKFLOW_ENDPOINT_OVERRIDE: workflowEndpoint,
    WORKFLOW_TIMEOUT_MS: '5000',
  };
  compose({
    project: externalProject,
    file: externalComposeFile,
    args: ['-f', externalOverride, 'up', '--no-build', '-d', 'web'],
    environment: externalEnvironment,
  });
  externalWebContainer = compose({
    project: externalProject,
    file: externalComposeFile,
    args: ['-f', externalOverride, 'ps', '-q', 'web'],
    environment: externalEnvironment,
  });
  assert(externalWebContainer, 'external Compose Web container must exist');
  const externalReady = await waitForHttp(`${externalBackendOrigin}/readyz`, 'external DATABASE_URL readiness', 120_000);
  assert.deepEqual(await externalReady.json(), { ok: true, service: 'polar-web' });

  const externalAdminResult = compose({
    project: externalProject,
    file: externalComposeFile,
    environment: externalEnvironment,
    args: ['-f', externalOverride, 'exec', '-T', 'web', 'npm', 'run', 'user:create', '--',
      '--email', externalEmail,
      '--username', externalUsername,
      '--password', externalPassword,
      '--verified',
    ],
  });
  assert.match(externalAdminResult, new RegExp(`Created verified user: ${externalUsername}$`));

  await page.goto(`${externalOrigin}/login`, { waitUntil: 'domcontentloaded' });
  await fillLogin(externalUsername, externalPassword);
  await page.getByRole('heading', { name: '创建第一个项目' }).waitFor();
  const externalContextTitle = `外部数据库项目 ${suffix}`;
  const externalThreadTitle = `外部数据库线程 ${suffix}`;
  const externalMessage = `外部数据库消息 ${suffix}`;
  await page.getByLabel('项目名称').fill(externalContextTitle);
  await page.getByRole('button', { name: '创建项目' }).click();
  await page.getByTestId('workspace-slot').waitFor();
  await page.getByRole('button', { name: '新建线程', exact: true }).click();
  await page.getByLabel('线程标题').fill(externalThreadTitle);
  await Promise.all([
    page.waitForURL((url) => /^[0-9a-f-]{36}$/u.test(url.searchParams.get('thread') ?? '')),
    page.getByRole('button', { name: '创建线程' }).click(),
  ]);
  const externalThreadId = currentIds().threadId ?? '';
  assert.match(externalThreadId, /^[0-9a-f-]{36}$/);
  const workflowCallsBeforeExternal = workflowRequests.length;
  const externalCommand = await sendConversationMessage(externalMessage, `Echo · ${externalMessage}`);
  assert.equal(workflowCalls(externalCommand.commandId), 1);
  assert.equal(workflowRequests.length, workflowCallsBeforeExternal + 1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('product-bar').waitFor();
  await page.getByTestId('workspace-slot').waitFor();
  await page.getByText(`Echo · ${externalMessage}`, { exact: true }).waitFor();
  assert.match(await page.getByRole('button', { name: externalThreadTitle }).getAttribute('class'), /active-thread/);
  await assertNoHorizontalOverflow();
  assert.equal(await page.getByText(/LibreChat/i).count(), 0);
  assert.equal(await page.getByText(/MongoDB|Mongo/i).count(), 0);

  const externalCounts = psqlJson(externalPostgresContainer, `SELECT json_build_object(
    'users', (SELECT count(*) FROM users),
    'contexts', (SELECT count(*) FROM contexts),
    'routes', (SELECT count(*) FROM workflow_routes),
    'threads', (SELECT count(*) FROM workflow_threads),
    'checkpoints', (SELECT count(*) FROM workflow_checkpoints),
    'commands', (SELECT count(*) FROM workflow_commands),
    'messages', (SELECT count(*) FROM workflow_messages),
    'events', (SELECT count(*) FROM workflow_command_events),
    'interrupts', (SELECT count(*) FROM workflow_interrupts)
  );`, 'inspect external DATABASE_URL command persistence');
  assert.deepEqual(externalCounts, {
    users: 1,
    contexts: 1,
    routes: 1,
    threads: 1,
    checkpoints: 1,
    commands: 1,
    messages: 2,
    events: 5,
    interrupts: 0,
  });
  assert.equal(workflowServerErrors.length, 0, workflowServerErrors.map(String).join('\n'));

  assertNoLegacyRuntime();
  console.log('[QA PASS] native workflow command production release');
} catch (error) {
  failed = true;
  await preserveFailure(error);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (tlsProxy) await new Promise((resolve) => tlsProxy.close(resolve));
  if (externalTlsProxy) await new Promise((resolve) => externalTlsProxy.close(resolve));
  if (workflowServer) await new Promise((resolve) => workflowServer.close(resolve));
  if (mailpitProcess && !mailpitProcess.killed) mailpitProcess.kill('SIGTERM');
  if (releasePath) {
    spawnSync('docker', [
      'compose', '--project-name', externalProject,
      '-f', join(releasePath, 'compose.external-db.yml'),
      '-f', join(root, 'compose.external.qa.yml'),
      'down', '--volumes', '--remove-orphans',
    ], { stdio: 'ignore', env: externalEnvironment ?? process.env });
    spawnSync('docker', [
      'compose', '--project-name', bundledProject,
      '-f', join(releasePath, 'compose.yml'),
      'down', '--volumes', '--remove-orphans',
    ], { stdio: 'ignore', env: bundledEnvironment ?? process.env });
  }
  spawnSync('docker', ['rm', '-f', externalPostgresContainer], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  spawnSync('docker', ['rmi', '-f', image], { stdio: 'ignore' });
  rmSync(root, { recursive: true, force: true });
  if (!failed) rmSync(artifactRoot, { recursive: true, force: true });
}
