import { claimPolarPort } from './claim-polar-port.mjs';

const DEFAULT_PROCESS_URL = process.env.POLARPROCESS_URL ?? 'http://127.0.0.1:11055';
const DEFAULT_PORT_URL = process.env.POLARPORT_URL ?? 'http://127.0.0.1:11050';

function assertForegroundCommand(command) {
  if (/(?:\bnohup\b|\s&\s*$|\s-d(?:\s|$)|--detach\b)/.test(command)) {
    throw new Error('governed service command must stay in the foreground');
  }
}

export function buildGovernedServiceRegistration({ id, name, command, workDir, port, healthUrl }) {
  assertForegroundCommand(command);
  return {
    id,
    name,
    command,
    work_dir: workDir,
    port,
    health_check_url: healthUrl,
    auto_start: false,
    restart_on_failure: true,
    max_restarts: 3,
    device_id: 'any',
    start_script_dir: '-',
  };
}

async function jsonRequest(url, init, fetchImpl) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!response.ok || body.ok === false) {
    throw new Error(body.message || `${init.method ?? 'GET'} ${url} failed (${response.status})`);
  }
  return body;
}

export async function registerAndStartGovernedService(
  registration,
  { fetch: fetchImpl = fetch, baseUrl = DEFAULT_PROCESS_URL } = {},
) {
  return jsonRequest(`${baseUrl}/api/services/register-and-start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(registration),
  }, fetchImpl);
}

export async function runGovernedServiceAction(
  serviceId,
  action,
  { fetch: fetchImpl = fetch, baseUrl = DEFAULT_PROCESS_URL } = {},
) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error(`unsupported service action: ${action}`);
  return jsonRequest(`${baseUrl}/api/services/${encodeURIComponent(serviceId)}/${action}`, {
    method: 'POST',
  }, fetchImpl);
}

export async function claimGovernedQaPort({ serviceName, preferred, project = 'PolarUI' }) {
  return claimPolarPort({ serviceName, preferred, project });
}

export async function releaseGovernedQaPort(port, { fetch: fetchImpl = fetch, baseUrl = DEFAULT_PORT_URL } = {}) {
  return jsonRequest(`${baseUrl}/api/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  }, fetchImpl);
}

export async function waitForHttp(url, { timeoutMs = 120_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`health timeout: ${url}${lastError instanceof Error ? ` (${lastError.message})` : ''}`);
}
