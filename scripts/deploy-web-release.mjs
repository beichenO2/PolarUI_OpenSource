/**
 * Register + start web release via PolarProcess (after PolarPort claim).
 *
 * Failure semantics: if PolarProcess fails after ports were claimed, the
 * claimed ports are released back to PolarPort (best effort) and
 * site.config.json is left untouched — no half-deployed state on disk.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimPolarPort } from './claim-polar-port.mjs';

const POLARPROCESS_URL = process.env.POLARPROCESS_URL ?? 'http://127.0.0.1:11055';
const POLARPORT_URL = process.env.POLARPORT_URL ?? 'http://127.0.0.1:11050';

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
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

    const startRes = await fetch(`${POLARPROCESS_URL}/api/services/register-and-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serviceBody),
      signal: AbortSignal.timeout(30000),
    });
    const startBody = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !startBody.ok) {
      throw new Error(`PolarProcess register-and-start failed: ${startBody.message ?? startRes.status}`);
    }

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
