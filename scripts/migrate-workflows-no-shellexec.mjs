#!/usr/bin/env node
/**
 * ADR-004: 迁移所有 workflow JSON — ShellExec → CodeExec (language=shell) 或 FeishuIM。
 * 同时替换 tool list / allowed_types / system_prompt 中的 ShellExec 字符串引用。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WORKFLOW_DIRS = [
  join(ROOT, 'dist/workflows'),
  join(ROOT, 'workflows'),
];

/** feishu-im.json 是 FeishuIM 复合节点的 internal_workflow，不能用 ShellExec 调 executor */
const FEISHU_IM_REWRITE = {
  '1': {
    class_type: 'PromptInput',
    inputs: {},
    params: {
      content: 'FeishuIM payload',
      channel: 'feishu',
    },
  },
  '2': {
    class_type: 'FeishuIM',
    inputs: {
      webhook_payload: ['1', 0],
      text: ['1', 0],
      open_id: ['1', 1],
      pdf_path: ['1', 2],
    },
    params: {
      bot_name: 'PolarClaw_Rr',
      action: 'auto',
    },
  },
  '3': {
    class_type: 'Output',
    inputs: { content: ['2', 0] },
    params: { format: 'json' },
  },
  _name: 'Feishu IM 出站',
  _description: 'WYSIWYG：PromptInput → FeishuIM → Output。无 ShellExec。',
  _category: 'polarclaw',
  _entry: '1',
};

function walkJsonFiles(dir, acc = []) {
  if (!statSync(dir, { throwIfNoEntry: false })) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkJsonFiles(p, acc);
    else if (name.endsWith('.json')) acc.push(p);
  }
  return acc;
}

function replaceShellExecStrings(value) {
  if (typeof value === 'string') {
    return value
      .replace(/ShellExec/g, 'CodeExec')
      .replace(/"tool":"terminal"/g, '"tool":"code"')
      .replace(/terminal\|file\|web/g, 'code|file|web');
  }
  if (Array.isArray(value)) return value.map(replaceShellExecStrings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = replaceShellExecStrings(v);
    }
    return out;
  }
  return value;
}

function migrateShellExecNode(node) {
  if (node.class_type !== 'ShellExec') return node;

  const migrated = { ...node, class_type: 'CodeExec' };
  const inputs = { ...(node.inputs ?? {}) };

  if ('command' in inputs) {
    inputs.code = inputs.command;
    delete inputs.command;
  }
  migrated.inputs = inputs;

  const params = { ...(node.params ?? {}) };
  delete params.template;
  if (!params.language) params.language = 'shell';
  migrated.params = params;

  return migrated;
}

function migrateWorkflow(obj, filePath) {
  const base = filePath.split('/').pop();
  if (base === 'feishu-im.json') {
    return { ...FEISHU_IM_REWRITE, changed: true, special: 'feishu-im' };
  }

  let changed = false;
  const out = {};

  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('_') || /^\d+$/.test(key)) continue;
    out[key] = val;
  }

  for (const [key, val] of Object.entries(obj)) {
    if (!/^\d+$/.test(key) && !key.startsWith('_')) continue;

    if (val && typeof val === 'object' && val.class_type === 'ShellExec') {
      out[key] = migrateShellExecNode(val);
      changed = true;
    } else {
      out[key] = val;
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('_')) {
      out[key] = replaceShellExecStrings(val);
      if (JSON.stringify(out[key]) !== JSON.stringify(val)) changed = true;
    }
  }

  // 第二轮：字符串字段中的 ShellExec 引用（StaticData value、system_prompt 等）
  const before = JSON.stringify(out);
  const replaced = replaceShellExecStrings(out);
  if (JSON.stringify(replaced) !== before) changed = true;

  return { ...replaced, changed };
}

function main() {
  const files = new Set();
  for (const dir of WORKFLOW_DIRS) {
    for (const f of walkJsonFiles(dir)) files.add(f);
  }

  let migrated = 0;
  let skipped = 0;
  const report = [];

  for (const filePath of [...files].sort()) {
    const raw = readFileSync(filePath, 'utf8');
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      report.push({ file: relative(ROOT, filePath), status: 'skip', reason: 'invalid JSON' });
      skipped++;
      continue;
    }

    const result = migrateWorkflow(obj, filePath);
    if (!result.changed) {
      skipped++;
      continue;
    }

    const { changed, special, ...workflow } = result;
    writeFileSync(filePath, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
    migrated++;
    report.push({
      file: relative(ROOT, filePath),
      status: 'migrated',
      special: special ?? null,
    });
  }

  console.log(`migrate-workflows-no-shellexec: ${migrated} migrated, ${skipped} unchanged`);
  for (const r of report) {
    console.log(`  ${r.status}: ${r.file}${r.special ? ` (${r.special})` : ''}`);
  }
}

main();
