/**
 * Verify release directory structure (Step 10).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED = [
  'site.manifest.json',
  'site.config.json',
  'workflow/snapshot.lg.json',
  'config/memory-schema.json',
  'config/required-executors.json',
  'README.md',
  'EXPORT.log',
];

/**
 * @param {string} releaseRoot
 */
export function verifyRelease(releaseRoot) {
  const errors = [];
  for (const rel of REQUIRED) {
    const p = join(releaseRoot, rel);
    if (!existsSync(p)) errors.push(`missing: ${rel}`);
  }

  if (existsSync(join(releaseRoot, 'site.manifest.json'))) {
    const manifest = JSON.parse(readFileSync(join(releaseRoot, 'site.manifest.json'), 'utf8'));
    if (!Array.isArray(manifest.compile_steps) || manifest.compile_steps.length < 6) {
      errors.push('compile_steps length < 6');
    }
    const snap = join(releaseRoot, manifest.workflow_snapshot ?? 'workflow/snapshot.lg.json');
    if (!existsSync(snap)) errors.push('workflow snapshot missing');
  }

  // No external symlinks to workflows/
  if (existsSync(join(releaseRoot, 'workflows'))) {
    errors.push('must not contain workflows/ external copy');
  }

  return { ok: errors.length === 0, errors };
}

export default verifyRelease;
