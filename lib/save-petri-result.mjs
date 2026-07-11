/**
 * Node-only persistence for PetriDish refined workflows (ADR-014 D3).
 * Writes workflows/<name>.petri.json — never registry-entry.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const POLARUI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {object} workflow
 * @param {string} name
 * @param {string} [dir]
 */
export function savePetriResult(workflow, name, dir) {
  const base = dir ?? join(POLARUI_ROOT, 'workflows');
  const stem = name.replace(/\.petri\.json$/i, '').replace(/\.json$/i, '');
  const filename = `${stem}.petri.json`;
  const path = join(base, filename);
  mkdirSync(base, { recursive: true });
  writeFileSync(path, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  return path;
}
