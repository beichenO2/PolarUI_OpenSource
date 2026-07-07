/**
 * Merge compile outputs into site.config.json + site.manifest.json
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  return { manifest, config, checksum };
}

export default compileSiteConfig;
