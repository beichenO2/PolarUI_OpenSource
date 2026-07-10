/**
 * Patch librechat.yaml modelSpecs.list (+ models.default) for http_workflows.
 * Uses js-yaml (already present under PolarUI node_modules).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

/**
 * @param {string} yamlText
 * @param {Array<{ id: string, label?: string, description?: string, url: string }>} httpWorkflows
 * @returns {{ yaml: string, added: number, endpoint: string }}
 */
export function patchLibreChatHttpWorkflows(yamlText, httpWorkflows) {
  if (!httpWorkflows?.length) {
    return { yaml: yamlText, added: 0, endpoint: '' };
  }

  const doc = yaml.load(yamlText);
  if (!doc || typeof doc !== 'object') {
    throw new Error('librechat.yaml is not a mapping');
  }

  const custom = doc.endpoints?.custom;
  const endpoint =
    Array.isArray(custom) && custom[0]?.name ? String(custom[0].name) : 'PolarWorkflow';

  if (!doc.modelSpecs) doc.modelSpecs = {};
  if (!Array.isArray(doc.modelSpecs.list)) doc.modelSpecs.list = [];

  const existing = new Set(doc.modelSpecs.list.map((e) => e?.name).filter(Boolean));
  let added = 0;

  for (const wf of httpWorkflows) {
    if (!wf?.id) continue;
    if (existing.has(wf.id)) continue;
    const entry = {
      name: wf.id,
      label: wf.label || wf.id,
    };
    if (wf.description) entry.description = wf.description;
    entry.preset = {
      endpoint,
      model: wf.id,
    };
    doc.modelSpecs.list.push(entry);
    existing.add(wf.id);
    added++;
  }

  if (Array.isArray(custom) && custom[0]) {
    if (!custom[0].models) custom[0].models = {};
    const defaults = Array.isArray(custom[0].models.default) ? [...custom[0].models.default] : [];
    const seen = new Set(defaults);
    for (const wf of httpWorkflows) {
      if (!wf?.id || seen.has(wf.id)) continue;
      defaults.push(wf.id);
      seen.add(wf.id);
    }
    custom[0].models.default = defaults;
  }

  // Prefer double-quoted strings to match template style; keep models.default as flow seq.
  const dumped = yaml.dump(doc, {
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
    forceQuotes: true,
    styles: {
      '!!null': 'canonical',
    },
  }).replace(
    /^(\s+default):\n((?:\s+-\s+.+\n)+)/gm,
    (_, key, block) => {
      const items = [...block.matchAll(/-\s+(.+)/g)].map((m) => m[1].trim());
      if (items.length === 0) return `${key}:\n${block}`;
      // Only collapse short id lists under models.default
      if (items.every((x) => /^"?[\w.-]+"?$/.test(x))) {
        return `${key}: [${items.join(', ')}]\n`;
      }
      return `${key}:\n${block}`;
    },
  );

  // Preserve leading comment block from the original file when present.
  const leadComments = [];
  for (const line of yamlText.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') leadComments.push(line);
    else break;
  }
  const prefix = leadComments.length ? leadComments.join('\n').replace(/\n+$/, '') + '\n' : '';

  return { yaml: prefix + dumped, added, endpoint };
}

export default patchLibreChatHttpWorkflows;
