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
    if (raw.auth_token != null) {
      if (typeof raw.auth_token !== 'string' || raw.auth_token.trim() === '') {
        throw new Error(`http_workflows[${i}].auth_token must be a non-empty string`);
      }
      entry.auth_token = raw.auth_token;
    }
    if (raw.headers != null) {
      if (!raw.headers || typeof raw.headers !== 'object' || Array.isArray(raw.headers)) {
        throw new Error(`http_workflows[${i}].headers must be an object`);
      }
      /** @type {Record<string, string>} */
      const headers = {};
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof k !== 'string' || typeof v !== 'string') {
          throw new Error(`http_workflows[${i}].headers keys and values must be strings`);
        }
        headers[k] = v;
      }
      entry.headers = headers;
    }
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
    templateFlavor = 'legacy',
    databaseMode = 'bundled',
  } = p;

  if (templateFlavor === 'native' && !['bundled', 'external'].includes(databaseMode)) {
    throw new Error(`unsupported native database mode: ${databaseMode}`);
  }

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
    template_flavor: templateFlavor,
  };

  const common = {
    release_id: releaseId,
    workflow_id: workflowId,
    template_flavor: templateFlavor,
    engine: 'polarflow',
    polarflow: {
      api_url_env: 'WORKFLOW_ENGINE_URL',
      default_api_url: 'http://127.0.0.1:8065',
      flow_path: `${workflowId}/flow.json`,
    },
    port: null,
    registry: registry ?? {},
    required_executors: requiredExecutors ?? [],
    memory_schema: memorySchemaRel,
  };

  const config = templateFlavor === 'native'
    ? {
        ...common,
        preferred_web_port: 3920,
        web: {
          template_flavor: 'native',
          database_mode: databaseMode,
          identity: {
            provider: 'native-postgresql',
            email_verification: 'six-digit-code',
            login_identifiers: ['email', 'username'],
          },
        },
      }
    : {
        ...common,
        polarflow: {
          ...common.polarflow,
          host_api_url: 'http://127.0.0.1:8065',
        },
        preferred_api_port: 3920,
        preferred_lc_port: 3080,
        librechat_port: null,
      };

  const normalized = normalizeHttpWorkflows(httpWorkflows);
  if (normalized.length > 0) {
    config.http_workflows = normalized;
  }

  return { manifest, config, checksum };
}

export default compileSiteConfig;
