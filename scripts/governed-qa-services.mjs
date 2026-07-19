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

async function waitForGovernedServiceStatus(
  serviceId,
  expectedStatus,
  {
    fetch: fetchImpl = fetch,
    baseUrl = DEFAULT_PROCESS_URL,
    timeoutMs = 120_000,
    intervalMs = 300,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const service = await jsonRequest(
        `${baseUrl}/api/services/${encodeURIComponent(serviceId)}`,
        { method: 'GET' },
        fetchImpl,
      );
      lastStatus = service.status ?? 'unknown';
      if (lastStatus === expectedStatus) return service;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `PolarProcess ${serviceId} did not reach ${expectedStatus} (last status: ${lastStatus})`
      + (lastError instanceof Error ? `: ${lastError.message}` : ''),
  );
}

export async function restartGovernedServiceWithPort(
  { serviceId, serviceName = serviceId, preferred, project = 'PolarUI' },
  {
    runServiceAction = runGovernedServiceAction,
    waitForServiceStatus = waitForGovernedServiceStatus,
    claimPort = claimGovernedQaPort,
    releasePort = releaseGovernedQaPort,
  } = {},
) {
  await runServiceAction(serviceId, 'stop');
  await waitForServiceStatus(serviceId, 'stopped');
  const claimed = await claimPort({ serviceName, preferred, project });

  async function releaseAfterFailure(primaryError) {
    try {
      await releasePort(claimed, { serviceName, project });
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        `governed restart failed and PolarPort cleanup failed for ${serviceName} on port ${claimed}`,
      );
    }
    throw primaryError;
  }

  if (claimed !== preferred) {
    return releaseAfterFailure(
      new Error(`PolarPort claimed alternate port ${claimed} instead of required port ${preferred}`),
    );
  }
  try {
    return await runServiceAction(serviceId, 'start');
  } catch (startError) {
    return releaseAfterFailure(startError);
  }
}

export async function claimGovernedQaPort({ serviceName, preferred, project = 'PolarUI' }) {
  return claimPolarPort({ serviceName, preferred, project });
}

export async function releaseGovernedQaPort(
  port,
  {
    serviceName,
    project,
    fetch: fetchImpl = fetch,
    baseUrl = DEFAULT_PORT_URL,
  } = {},
) {
  const ownerAware = serviceName !== undefined || project !== undefined;
  const owner = !ownerAware
    ? {}
    : { service_name: serviceName, project };
  if (ownerAware) {
    const entries = await jsonRequest(
      `${baseUrl}/api/list?all=true`,
      { method: 'GET' },
      fetchImpl,
    );
    if (!Array.isArray(entries)) throw new Error('PolarPort owner preflight returned a non-array registry');
    const activeRows = entries.filter((entry) => entry.port === port && entry.status === 'active');
    if (activeRows.length !== 1) {
      throw new Error(
        `PolarPort owner preflight expected exactly one active row for port ${port}, found ${activeRows.length}`,
      );
    }
    const [activeOwner] = activeRows;
    if (activeOwner.service_name !== serviceName || activeOwner.project !== project) {
      throw new Error(
        `PolarPort port ${port} owned by ${activeOwner.service_name}/${activeOwner.project}, not ${serviceName}/${project}`,
      );
    }
  }
  return jsonRequest(`${baseUrl}/api/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port, ...owner }),
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
