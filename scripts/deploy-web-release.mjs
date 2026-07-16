/**
 * Register + start web release via PolarProcess (after PolarPort claim).
 *
 * Failure semantics: if PolarProcess fails after ports were claimed, the
 * claimed ports are released back to PolarPort (best effort) and
 * site.config.json is left untouched — no half-deployed state on disk.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claimPolarPort } from './claim-polar-port.mjs';

const POLARPROCESS_URL = process.env.POLARPROCESS_URL ?? 'http://127.0.0.1:11055';
const POLARPORT_URL = process.env.POLARPORT_URL ?? 'http://127.0.0.1:11050';

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const NATIVE_COMMON_ENV = [
  'AUTH_PEPPER',
  'PUBLIC_APP_ORIGIN',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_FROM',
  'SMTP_SECURE',
];

function safeName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 48);
}

function resolveNativeComposeProject(releaseId, environment) {
  const project = environment.POLAR_NATIVE_COMPOSE_PROJECT ?? `polar-${safeName(releaseId)}`;
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(project)) {
    throw new Error('POLAR_NATIVE_COMPOSE_PROJECT must be a valid lowercase Docker Compose project name');
  }
  return project;
}

function requireEnvironment(environment, names) {
  const missing = names.filter((name) => !environment[name]);
  if (missing.length > 0) throw new Error(`native deployment requires ${missing.join(', ')}`);
}

export function resolveNativePreferredPort(config, environment = process.env) {
  const raw = environment.POLAR_WEB_PREFERRED_PORT ?? config.preferred_web_port ?? 3920;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error('POLAR_WEB_PREFERRED_PORT must be an integer between 1024 and 65535');
  }
  return port;
}

export function buildNativeDeploymentPlan({
  databaseMode = 'bundled',
  releaseRoot,
  releaseId,
  webPort,
  environment = process.env,
  envFilePath = join(homedir(), '.config', 'polarui', 'release-env', `${safeName(releaseId)}.env`),
}) {
  if (!['bundled', 'external'].includes(databaseMode)) {
    throw new Error(`unsupported native database mode: ${databaseMode}`);
  }
  requireEnvironment(environment, [
    ...NATIVE_COMMON_ENV,
    ...(databaseMode === 'bundled' ? ['POSTGRES_PASSWORD'] : ['DATABASE_URL']),
  ]);

  const projectName = resolveNativeComposeProject(releaseId, environment);
  const containerName = `${projectName}-web`.slice(0, 63);
  const imageTag = `polar-native-${safeName(releaseId)}:latest`;
  if (databaseMode === 'bundled') {
    return {
      databaseMode,
      composeProject: projectName,
      containerName,
      imageTag,
      envFilePath,
      command: [
        'docker compose',
        '--project-name', shellQuote(projectName),
        '--env-file', shellQuote(envFilePath),
        '-f', shellQuote(join(releaseRoot, 'compose.yml')),
        'up --build web',
      ].join(' '),
      cleanupCommand: [
        'docker compose',
        '--project-name', shellQuote(projectName),
        '--env-file', shellQuote(envFilePath),
        '-f', shellQuote(join(releaseRoot, 'compose.yml')),
        'down',
      ].join(' '),
    };
  }

  return {
    databaseMode,
    containerName,
    imageTag,
    envFilePath,
    command: [
      'docker run --rm',
      `--name ${shellQuote(containerName)}`,
      `--env-file ${shellQuote(envFilePath)}`,
      `-p 127.0.0.1:${webPort}:3920`,
      shellQuote(imageTag),
    ].join(' '),
    cleanupCommand: `docker rm -f ${shellQuote(containerName)}`,
  };
}

export function buildNativeServiceRegistration({
  serviceId,
  releaseId,
  command,
  releaseRoot,
  webPort,
}) {
  return {
    id: serviceId,
    name: `Web ${releaseId}`,
    command,
    work_dir: releaseRoot,
    port: webPort,
    health_check_url: `http://127.0.0.1:${webPort}/readyz`,
    auto_start: true,
    restart_on_failure: true,
    max_restarts: 5,
    device_id: 'any',
    start_script_dir: '-',
  };
}

export function writeNativeEnvFile(plan, environment, webPort) {
  mkdirSync(join(homedir(), '.config', 'polarui', 'release-env'), { recursive: true });
  const names = [
    'NODE_ENV', 'DATABASE_URL', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
    'AUTH_PEPPER', 'PUBLIC_APP_ORIGIN', 'COOKIE_SECURE', 'TRUST_PROXY', 'SMTP_HOST', 'SMTP_PORT',
    'SMTP_FROM', 'SMTP_SECURE', 'SMTP_USERNAME', 'SMTP_PASSWORD',
    'WORKFLOW_ENDPOINT_OVERRIDE', 'WORKFLOW_TIMEOUT_MS',
  ];
  const defaults = { NODE_ENV: 'production', COOKIE_SECURE: 'true' };
  const lines = [`POLAR_WEB_PORT=${webPort}`];
  for (const name of names) {
    const value = environment[name] ?? defaults[name];
    if (value != null) lines.push(`${name}=${String(value).replace(/[\r\n]/g, '')}`);
  }
  writeFileSync(plan.envFilePath, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(plan.envFilePath, 0o600);
}

async function releasePolarPort(port) {
  if (typeof port !== 'number') return;
  try {
    await fetch(`${POLARPORT_URL}/api/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* best effort */
  }
}

async function registerAndStartService(serviceBody) {
  const response = await fetch(`${POLARPROCESS_URL}/api/services/register-and-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serviceBody),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(`PolarProcess register-and-start failed: ${body.message ?? response.status}`);
  }
  return body;
}

/**
 * @param {object} opts
 * @param {string} opts.releaseRoot
 * @param {string} opts.releaseId
 * @param {string} opts.polaruiRoot
 * @param {boolean} [opts.startLibreChat]
 */
export async function deployWebRelease(opts) {
  const { releaseRoot, releaseId, polaruiRoot } = opts;
  const configPath = join(releaseRoot, 'site.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  if (config.template_flavor === 'native') {
    const webService = `web-${releaseId}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
    const databaseMode = opts.databaseMode ?? config.web?.database_mode ?? 'bundled';
    const environment = opts.environment ?? process.env;
    let webPort = null;
    let plan = null;
    try {
      webPort = await claimPolarPort({
        serviceName: webService,
        project: 'PolarUI',
        preferred: resolveNativePreferredPort(config, environment),
      });
      plan = buildNativeDeploymentPlan({
        databaseMode,
        releaseRoot,
        releaseId,
        webPort,
        environment,
      });
      writeNativeEnvFile(plan, environment, webPort);
      if (databaseMode === 'external') {
        const build = spawnSync('docker', ['build', '-t', plan.imageTag, '.'], {
          cwd: releaseRoot,
          stdio: 'inherit',
        });
        if (build.status !== 0) throw new Error('native web docker build failed');
      }
      const serviceBody = buildNativeServiceRegistration({
        serviceId: webService,
        releaseId,
        command: plan.command,
        releaseRoot,
        webPort,
      });
      const start = await registerAndStartService(serviceBody);
      config.port = webPort;
      config.web = { ...config.web, database_mode: databaseMode };
      config.polarport = {
        web_service: webService,
        allocated_at: new Date().toISOString(),
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      const deploy = {
        web_port: webPort,
        web_url: `http://127.0.0.1:${webPort}/`,
        service_id: webService,
        database_mode: databaseMode,
        compose_project: plan.composeProject ?? null,
      };
      mkdirSync(join(releaseRoot, 'injected'), { recursive: true });
      writeFileSync(join(releaseRoot, 'injected/deploy.json'), JSON.stringify(deploy, null, 2));
      return { ok: true, ...deploy, start };
    } catch (error) {
      await releasePolarPort(webPort);
      if (plan?.cleanupCommand) spawnSync('sh', ['-lc', plan.cleanupCommand], { stdio: 'ignore' });
      if (plan?.databaseMode === 'external') spawnSync('docker', ['rmi', '-f', plan.imageTag], { stdio: 'ignore' });
      if (plan?.envFilePath) rmSync(plan.envFilePath, { force: true });
      throw error;
    }
  }

  const apiService = `web-${releaseId}-api`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  const lcService = `web-${releaseId}-lc`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);

  const apiPort = await claimPolarPort({
    serviceName: apiService,
    project: 'PolarUI',
    preferred: config.preferred_api_port ?? 3920,
  });

  let lcPort = null;
  try {
    if (opts.startLibreChat !== false) {
      lcPort = await claimPolarPort({
        serviceName: lcService,
        project: 'PolarUI',
        preferred: config.preferred_lc_port ?? 3080,
      });
    }

    const startCmd = [
      'env',
      `PORT=${apiPort}`,
      `POLARUI_ROOT=${shellQuote(polaruiRoot)}`,
      'node polar/server.mjs',
    ].join(' ');

    const serviceBody = {
      id: apiService,
      name: `Web ${releaseId} API`,
      command: startCmd,
      work_dir: releaseRoot,
      port: apiPort,
      health_check_url: `http://127.0.0.1:${apiPort}/`,
      auto_start: true,
      restart_on_failure: true,
      max_restarts: 5,
      device_id: 'any',
    };

    const startBody = await registerAndStartService(serviceBody);

    // Persist ports only after the service actually started.
    config.port = apiPort;
    config.librechat_port = lcPort;
    config.polarport = { api_service: apiService, lc_service: lcService, allocated_at: new Date().toISOString() };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    writeFileSync(
      join(releaseRoot, 'polar/injected/deploy.json'),
      JSON.stringify({
        api_port: apiPort,
        librechat_port: lcPort,
        api_url: `http://127.0.0.1:${apiPort}/`,
        librechat_url: lcPort ? `http://127.0.0.1:${lcPort}/` : null,
        service_id: apiService,
      }, null, 2),
    );

    return {
      ok: true,
      api_port: apiPort,
      librechat_port: lcPort,
      api_url: `http://127.0.0.1:${apiPort}/`,
      chat_url: lcPort ? `http://127.0.0.1:${lcPort}/` : null,
      service_id: apiService,
      start: startBody,
    };
  } catch (e) {
    await releasePolarPort(apiPort);
    await releasePolarPort(lcPort);
    throw e;
  }
}

export default deployWebRelease;
