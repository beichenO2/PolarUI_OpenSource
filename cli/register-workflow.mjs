#!/usr/bin/env node
/**
 * PolarUI Workflow CLI — register/list/search workflows
 *
 * Usage:
 *   node cli/register-workflow.mjs <path-to-workflow.json> [--name "名称"] [--desc "描述"] [--category "分类"]
 *   node cli/register-workflow.mjs --list [--query "搜索词"]
 *   node cli/register-workflow.mjs --remove <id>
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const WORKFLOWS_DIR = join(PROJECT_ROOT, 'workflows');
const REGISTRY_FILE = join(WORKFLOWS_DIR, 'registry.json');

function loadRegistry() {
  if (!existsSync(REGISTRY_FILE)) return [];
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch { return []; }
}

function saveRegistry(entries) {
  mkdirSync(WORKFLOWS_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
}

function parseArgs(argv) {
  const args = { _positional: [] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._positional.push(argv[i]);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.list) {
  const entries = loadRegistry();
  const query = args.query?.toLowerCase();
  const filtered = query
    ? entries.filter(e => e.name.toLowerCase().includes(query) || e.description.toLowerCase().includes(query))
    : entries;

  if (filtered.length === 0) {
    console.log('No workflows registered.');
  } else {
    console.log(`\n  📋 Registered Workflows (${filtered.length}):\n`);
    for (const e of filtered) {
      console.log(`  [${e.id.slice(0, 8)}] ${e.name}`);
      if (e.description) console.log(`           ${e.description}`);
      console.log(`           category: ${e.category} | nodes: ${e.nodeCount} | file: ${e.file}`);
      console.log('');
    }
  }
  process.exit(0);
}

if (args.remove) {
  const entries = loadRegistry();
  const idx = entries.findIndex(e => e.id === args.remove || e.id.startsWith(args.remove));
  if (idx < 0) {
    console.error(`Not found: ${args.remove}`);
    process.exit(1);
  }
  const removed = entries.splice(idx, 1)[0];
  saveRegistry(entries);
  console.log(`Removed: ${removed.name} (${removed.id})`);
  process.exit(0);
}

// Register mode
const filePath = args._positional[0];
if (!filePath) {
  console.error('Usage: register-workflow.mjs <path-to-workflow.json> [--name "名称"] [--desc "描述"] [--category "分类"]');
  console.error('       register-workflow.mjs --list [--query "搜索词"]');
  console.error('       register-workflow.mjs --remove <id>');
  process.exit(1);
}

const absPath = resolve(filePath);
if (!existsSync(absPath)) {
  console.error(`File not found: ${absPath}`);
  process.exit(1);
}

const json = readFileSync(absPath, 'utf-8');
let parsed;
try {
  parsed = JSON.parse(json);
} catch (err) {
  console.error(`Invalid JSON: ${err.message}`);
  process.exit(1);
}

const nodeCount = Array.isArray(parsed.nodes)
  ? parsed.nodes.length
  : Object.keys(parsed).filter(k => !k.startsWith('_')).length;

const name = args.name || parsed._name || basename(absPath, '.json');
const description = args.desc || parsed._description || '';
const category = args.category || 'general';

// Copy file to workflows/ if not already there
const destFile = basename(absPath);
const destPath = join(WORKFLOWS_DIR, destFile);
if (absPath !== destPath) {
  mkdirSync(WORKFLOWS_DIR, { recursive: true });
  copyFileSync(absPath, destPath);
}

const entries = loadRegistry();
const existing = entries.find(e => e.file === destFile);

const entry = {
  id: existing?.id || randomUUID(),
  name,
  description,
  category,
  nodeCount,
  file: destFile,
  registeredAt: existing?.registeredAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

if (existing) {
  const idx = entries.indexOf(existing);
  entries[idx] = entry;
  console.log(`Updated: ${name} → workflows/${destFile}`);
} else {
  entries.push(entry);
  console.log(`Registered: ${name} → workflows/${destFile}`);
}

saveRegistry(entries);
console.log(`  id: ${entry.id}`);
console.log(`  nodes: ${nodeCount}`);
console.log(`  category: ${category}`);
