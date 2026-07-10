/**
 * Verify release directory structure + content integrity (Step 10).
 *
 * Beyond existence checks, this now validates:
 * - every JSON artifact actually parses
 * - manifest ↔ snapshot checksum match (frozen-release guarantee)
 * - required-executors is a non-empty list
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED = [
  'site.manifest.json',
  'site.config.json',
  'workflow/snapshot.json',
  'config/memory-schema.json',
  'config/required-executors.json',
  'README.md',
  'EXPORT.log',
];

const JSON_FILES = [
  'site.manifest.json',
  'site.config.json',
  'workflow/snapshot.json',
  'config/memory-schema.json',
  'config/required-executors.json',
];

/**
 * @param {string} releaseRoot
 * @returns {{ ok: boolean, errors: string[], checked: number }}
 */
export function verifyRelease(releaseRoot) {
  const errors = [];
  let checked = 0;

  for (const rel of REQUIRED) {
    checked++;
    if (!existsSync(join(releaseRoot, rel))) errors.push(`missing: ${rel}`);
  }

  const parsed = {};
  for (const rel of JSON_FILES) {
    const p = join(releaseRoot, rel);
    if (!existsSync(p)) continue;
    checked++;
    try {
      parsed[rel] = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      errors.push(`invalid JSON: ${rel} (${e.message})`);
    }
  }

  const manifest = parsed['site.manifest.json'];
  if (manifest) {
    checked++;
    for (const field of ['release_id', 'workflow_id', 'workflow_snapshot', 'workflow_checksum']) {
      if (!manifest[field]) errors.push(`manifest missing field: ${field}`);
    }
    if (!Array.isArray(manifest.compile_steps) || manifest.compile_steps.length < 6) {
      errors.push('compile_steps length < 6');
    }
    const snapRel = manifest.workflow_snapshot ?? 'workflow/snapshot.json';
    const snapPath = join(releaseRoot, snapRel);
    if (!existsSync(snapPath)) {
      errors.push('workflow snapshot missing');
    } else if (typeof manifest.workflow_checksum === 'string' && manifest.workflow_checksum.startsWith('sha256:')) {
      checked++;
      const actual = `sha256:${createHash('sha256').update(readFileSync(snapPath, 'utf8')).digest('hex')}`;
      if (actual !== manifest.workflow_checksum) {
        errors.push(`workflow checksum mismatch: manifest=${manifest.workflow_checksum} actual=${actual}`);
      }
    }
  }

  const executors = parsed['config/required-executors.json'];
  if (executors) {
    checked++;
    if (!Array.isArray(executors.executors) || executors.executors.length === 0) {
      errors.push('required-executors is empty — graph scan produced no class_type');
    }
  }

  // No external symlinks / copies of workflows/
  checked++;
  if (existsSync(join(releaseRoot, 'workflows'))) {
    errors.push('must not contain workflows/ external copy');
  }

  return { ok: errors.length === 0, errors, checked };
}

export default verifyRelease;
