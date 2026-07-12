/**
 * L3 release orthogonality gate — no dev-machine umbilical cords.
 * @see docs/DEPLOYMENT_SPEC.md §2–§3
 */
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Dev-machine ports that must not appear in L3 deliverables (B1). */
const DEV_PORTS = '8120|8125|12790|11050|11055|5170';

/** Match :8120, localhost:8120, 127.0.0.1:8120 — avoid 138120418-style false positives. */
const DEV_PORT_PATTERN =
  `(?::(?:${DEV_PORTS})\\b|(?:127\\.0\\.0\\.1|localhost):(?:${DEV_PORTS})\\b)`;

const DEV_PATH_PATTERN = String.raw`~/Polarisor|~/Polarisor`;

/** Non-empty sensitive env assignment (R1 / §3.6). */
const ENV_SECRET_LINE = /^(\w*_(API_KEY|PASSWORD|SECRET|TOKEN))=.{3,}/;

/** Upstream LibreChat vendor `.env.example` files — not L3 config; excluded from secret scan. */
function isExcludedEnvFile(fullPath, stagingRoot) {
  const rel = relative(resolve(stagingRoot), resolve(fullPath)).replace(/\\/g, '/');
  return rel.startsWith('upstream/');
}

const RG_GLOBS = [
  '--glob', '!*.md',
  '--glob', '!EXPORT.log*',
  '--glob', '!node_modules/**',
  '--glob', '!**/*.map',
];

/**
 * @param {string} child
 * @param {string} parent
 */
function isPathInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * @param {string} dir
 * @param {string} stagingRoot
 * @param {string[]} violations
 */
function walkSymlinks(dir, stagingRoot, violations) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      let target;
      try {
        target = readlinkSync(full);
      } catch (e) {
        violations.push(`symlink (unreadable): ${full}`);
        continue;
      }
      const resolved = isAbsolute(target) ? resolve(target) : resolve(dirname(full), target);
      if (!isPathInside(resolved, stagingRoot)) {
        violations.push(`symlink outside staging: ${full} -> ${target} (resolved ${resolved})`);
      }
      continue;
    }
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      walkSymlinks(full, stagingRoot, violations);
    }
  }
}

/**
 * @param {string} pattern
 * @param {string} stagingRoot
 * @param {string} label
 * @returns {string[]}
 */
function rgScan(pattern, stagingRoot, label) {
  const r = spawnSync(
    'rg',
    ['-n', '--no-heading', '-e', pattern, stagingRoot, ...RG_GLOBS],
    { encoding: 'utf8' },
  );
  if (r.error?.code === 'ENOENT') {
    return walkTextScan(stagingRoot, new RegExp(pattern), label);
  }
  if (r.status === 1) return [];
  if (r.status !== 0 && r.status !== 2) {
    throw new Error(`${label} scan failed: ${r.stderr?.trim() || r.error?.message || r.status}`);
  }
  return r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${label}: ${line}`);
}

/**
 * Fallback when rg is unavailable.
 * @param {string} root
 * @param {RegExp} re
 * @param {string} label
 */
function walkTextScan(root, re, label) {
  /** @type {string[]} */
  const hits = [];
  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (ent.name.endsWith('.md')) continue;
      if (ent.name.startsWith('EXPORT.log')) continue;
      if (ent.name.endsWith('.map')) continue;
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${label}: ${full}:${i + 1}:${lines[i].trim()}`);
        }
      }
    }
  }
  walk(root);
  return hits;
}

/**
 * @param {string} stagingRoot
 */
function scanEnvSecrets(stagingRoot) {
  /** @type {string[]} */
  const hits = [];
  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/^\.env/.test(ent.name)) continue;
      if (isExcludedEnvFile(full, stagingRoot)) continue;
      const lines = readFileSync(full, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#')) continue;
        if (ENV_SECRET_LINE.test(line)) {
          hits.push(`env secret: ${full}:${i + 1}:${line}`);
        }
      }
    }
  }
  walk(stagingRoot);
  return hits;
}

/**
 * @param {string} stagingRoot
 * @returns {{ ok: boolean, errors: string[], checked: number }}
 */
export function verifyOrthogonality(stagingRoot) {
  const errors = [];
  let checked = 0;

  checked++;
  if (!existsSync(stagingRoot)) {
    errors.push(`staging root missing: ${stagingRoot}`);
    return { ok: false, errors, checked };
  }

  checked++;
  walkSymlinks(stagingRoot, stagingRoot, errors);

  checked++;
  errors.push(...rgScan(DEV_PORT_PATTERN, stagingRoot, 'dev port'));

  checked++;
  errors.push(...rgScan(DEV_PATH_PATTERN, stagingRoot, 'dev path'));

  checked++;
  errors.push(...scanEnvSecrets(stagingRoot));

  checked++;
  const envExample =
    existsSync(join(stagingRoot, '.env.example')) ||
    existsSync(join(stagingRoot, 'polar/.env.example'));
  if (!envExample) {
    errors.push('missing .env.example at release root or polar/.env.example');
  }

  return { ok: errors.length === 0, errors, checked };
}

export default verifyOrthogonality;
