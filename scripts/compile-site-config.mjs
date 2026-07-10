/**
 * Merge compile outputs into site.config.json + site.manifest.json
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Validate + normalize http_workflows entries.
 * Required: id, url. Duplicate ids throw.
 * @param {unknown} list
 * @returns {object[]}
 */
export function normalizeHttpWorkflows(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) {
    throw new Error('http_workflows must be an array');
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== 'object') {
      throw new Error(`http_workflows[${i}] must be an object`);
    }
    const id = raw.id;
    const url = raw.url;
    if (id == null || String(id).trim() === '') {
      throw new Error(`http_workflows[${i}].id is required`);
    }
    if (url == null || String(url).trim() === '') {
      throw new Error(`http_workflows[${i}].url is required`);
    }
    const idStr = String(id);
    if (seen.has(idStr)) {
      throw new Error(`duplicate http_workflows id: ${idStr}`);
    }
    seen.add(idStr);
    /** @type {Record<string, unknown>} */
    const entry = { id: idStr, url: String(url) };
    if (raw.label != null) entry.label = String(raw.label);
    if (raw.description != null) entry.description = String(raw.description);
    if (raw.timeout_ms != null) entry.timeout_ms = Number(raw.timeout_ms);
    out.push(entry);
  }
  return out;
}

/**
 * @param {object} p
 */
export function compileSiteConfig(p) {
  const {
    releaseId,
    workflowId,
    releaseRoot,
    exportEntry,
    compileSteps,
    workflowSnapshotRel,
    memorySchemaRel,
    registry,
    requiredExecutors,
    polaruiRoot,
    httpWorkflows,
  } = p;

  const snapshotPath = join(releaseRoot, workflowSnapshotRel);
  const snapshotRaw = readFileSync(snapshotPath, 'utf8');
  const checksum = `sha256:${createHash('sha256').update(snapshotRaw).digest('hex')}`;

  const exportedAt = new Date().toISOString();

  const manifest = {
    release_id: releaseId,
    workflow_id: workflowId,
    exported_at: exportedAt,
    export_entry: exportEntry,
    compile_steps: compileSteps,
    workflow_snapshot: workflowSnapshotRel,
    workflow_checksum: checksum,
    memory_schema: memorySchemaRel,
    web_root: releaseRoot,
  };

  const config = {
    release_id: releaseId,
    workflow_id: workflowId,
    polarui_root: polaruiRoot,
    preferred_api_port: 3920,
    preferred_lc_port: 3080,
    port: null,
    librechat_port: null,
    registry: registry ?? {},
    required_executors: requiredExecutors ?? [],
    memory_schema: memorySchemaRel,
  };

  const normalized = normalizeHttpWorkflows(httpWorkflows);
  if (normalized.length > 0) {
    config.http_workflows = normalized;
  }

  return { manifest, config, checksum };
}

export default compileSiteConfig;
