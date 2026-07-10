/**
 * P2a helpers: declare http_workflows for export-release.
 *
 * Sources (priority):
 * 1. workflows/{id}/http-workflows.json  (preferred dedicated file)
 * 2. else registry-entry.json → http_workflows[]
 * 3. CLI --http-workflow '<json>' (repeatable; appended; duplicate id → error)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeHttpWorkflows } from './compile-site-config.mjs';

/**
 * Parse argv for repeated `--http-workflow '<json>'`.
 * @param {string[]} argv
 * @returns {object[]}
 */
export function parseHttpWorkflowCliArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--http-workflow') continue;
    const raw = argv[++i];
    if (raw == null) throw new Error('--http-workflow requires a JSON argument');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`--http-workflow JSON parse failed: ${e.message}`);
    }
    if (Array.isArray(parsed)) out.push(...parsed);
    else out.push(parsed);
  }
  return out;
}

/**
 * @param {{ workflowDir: string, cliWorkflows?: object[] }} p
 * @returns {object[]}
 */
export function loadHttpWorkflowDeclarations(p) {
  const { workflowDir, cliWorkflows = [] } = p;
  /** @type {object[]} */
  let fromFile = [];

  const dedicated = join(workflowDir, 'http-workflows.json');
  if (existsSync(dedicated)) {
    const raw = JSON.parse(readFileSync(dedicated, 'utf8'));
    fromFile = Array.isArray(raw) ? raw : raw?.http_workflows ?? [];
  } else {
    const regPath = join(workflowDir, 'registry-entry.json');
    if (existsSync(regPath)) {
      const reg = JSON.parse(readFileSync(regPath, 'utf8'));
      if (Array.isArray(reg.http_workflows)) fromFile = reg.http_workflows;
    }
  }

  return normalizeHttpWorkflows([...fromFile, ...cliWorkflows]);
}

export default loadHttpWorkflowDeclarations;
