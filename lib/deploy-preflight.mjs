/**
 * Deploy preflight — checks external deps before Chat shell registration.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLARUI_ROOT = join(__dirname, '..');

/** @typedef {{ id: string; label: string; ok: boolean; detail: string; blocking?: boolean }} PreflightItem */

/**
 * @param {object} [opts]
 * @param {string} [opts.polarPrivateUrl]
 * @param {string} [opts.workflowId]
 */
export async function runDeployPreflight(opts = {}) {
  const polarPrivateUrl = (opts.polarPrivateUrl ?? process.env.POLARPRIVATE_URL ?? 'http://127.0.0.1:12790').replace(/\/$/, '');
  const workflowId = opts.workflowId ?? 'taoci-outreach';
  /** @type {PreflightItem[]} */
  const items = [];

  // PolarPrivate health
  try {
    const res = await fetch(`${polarPrivateUrl}/health`, { signal: AbortSignal.timeout(5000) });
    items.push({
      id: 'polarprivate',
      label: 'PolarPrivate',
      ok: res.ok,
      detail: res.ok ? `${polarPrivateUrl}/health OK` : `HTTP ${res.status}`,
      blocking: true,
    });
  } catch (e) {
    items.push({
      id: 'polarprivate',
      label: 'PolarPrivate',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      blocking: true,
    });
  }

  // Vault unlocked (models endpoint)
  try {
    const res = await fetch(`${polarPrivateUrl}/v1/models`, { signal: AbortSignal.timeout(8000) });
    const ok = res.ok;
    items.push({
      id: 'vault',
      label: 'Vault 已解锁',
      ok,
      detail: ok ? 'v1/models 可访问' : `Vault 未解锁或不可用 (HTTP ${res.status})`,
      blocking: true,
    });
  } catch (e) {
    items.push({
      id: 'vault',
      label: 'Vault 已解锁',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      blocking: true,
    });
  }

  // xelatex
  const which = spawnSync('which', ['xelatex'], { encoding: 'utf8' });
  const xelatexPath = (which.stdout ?? '').trim();
  items.push({
    id: 'xelatex',
    label: 'xelatex',
    ok: which.status === 0 && !!xelatexPath,
    detail: xelatexPath || '未找到 xelatex（S2/S3 PDF 将失败）',
    blocking: workflowId === 'taoci-outreach',
  });

  // Workflow graph exists
  const wfCandidates = [
    join(POLARUI_ROOT, 'workflows', workflowId, `${workflowId}.lg.json`),
    join(POLARUI_ROOT, 'dist/workflows', `${workflowId}.lg.json`),
  ];
  const wfPath = wfCandidates.find((p) => existsSync(p));
  items.push({
    id: 'workflow',
    label: 'workflow 图',
    ok: !!wfPath,
    detail: wfPath ?? `未找到 ${workflowId}.lg.json`,
    blocking: true,
  });

  // Taoci executors — overlay modules present + register-gui loads
  try {
    const { registerTaociGuiExecutors } = await import('./taoci-graph/register-gui.mjs');
    const { registerMemoryGuiExecutors } = await import('./memory-graph/register-gui.mjs');
    const { registerTaociExecutors } = await import('./taoci-graph/register.mjs');
    const { registerMemoryExecutors } = await import('./memory-graph/register.mjs');
    const types = [];
    const probe = (ct) => { types.push(ct); };
    registerMemoryGuiExecutors(probe);
    registerTaociGuiExecutors(probe);
    registerMemoryExecutors(probe);
    registerTaociExecutors(probe);
    const ok = types.includes('ScenarioMemoryLoad')
      && types.includes('ScenarioMemorySave')
      && types.includes('UserMemoryLoad')
      && types.includes('TaociSubAgent')
      && typeof registerTaociExecutors === 'function';
    items.push({
      id: 'taoci-executor',
      label: 'Taoci executor 已注册',
      ok,
      detail: ok ? `GUI+headless overlay (${types.join(', ')})` : `missing memory/taoci: ${types.join(', ')}`,
      blocking: workflowId === 'taoci-outreach',
    });
  } catch (e) {
    items.push({
      id: 'taoci-executor',
      label: 'Taoci executor 已注册',
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      blocking: workflowId === 'taoci-outreach',
    });
  }

  const blockingFailures = items.filter((i) => i.blocking !== false && !i.ok);
  return {
    ok: blockingFailures.length === 0,
    items,
    errors: blockingFailures.map((i) => `${i.label}: ${i.detail}`),
  };
}

export default runDeployPreflight;
