#!/usr/bin/env node
/**
 * Web release export — dual entry (CLI + PolarUI Web).
 * @see docs/WEB_EXPORT.md
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDeployPreflight } from '../lib/deploy-preflight.mjs';
import { compileMemorySchema } from './compile-memory-schema.mjs';
import { compileSiteConfig } from './compile-site-config.mjs';
import { verifyRelease } from './verify-release.mjs';
import { deployWebRelease } from './deploy-web-release.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLARUI_ROOT = join(__dirname, '..');
const WEB_ROOT = process.env.POLAR_WEB_ROOT ?? join(process.env.HOME ?? '~', 'Desktop/Web_related');
const TEMPLATE_DIR = join(WEB_ROOT, '_template');

const COMPILE_STEPS = ['graph', 'registry', 'memory-schema', 'prompts', 'executors', 'config', 'patch', 'verify', 'ports', 'deploy'];

function parseArgs(argv) {
  const out = {
    workflow: '',
    fromRelease: '',
    compileOnly: false,
    skipPreflight: false,
    json: false,
    exportEntry: 'cli',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow') out.workflow = argv[++i];
    else if (a === '--from-release') out.fromRelease = argv[++i];
    else if (a === '--compile-only') out.compileOnly = true;
    else if (a === '--skip-preflight') out.skipPreflight = true;
    else if (a === '--json') out.json = true;
    else if (a === '--export-entry') out.exportEntry = argv[++i];
  }
  return out;
}

/** @param {string} workflowId @param {string} webRoot @param {string} [fromRelease] */
export function resolveReleaseId(workflowId, webRoot, fromRelease) {
  let candidate = fromRelease || workflowId;
  while (existsSync(join(webRoot, candidate))) {
    candidate = `${candidate}_1`;
  }
  return candidate;
}

/**
 * @param {object} opts
 */
export async function exportRelease(opts) {
  const workflowId = opts.workflow;
  const webRoot = opts.webRoot ?? WEB_ROOT;
  const exportEntry = opts.exportEntry ?? 'cli';
  const logs = [];

  const releaseId = resolveReleaseId(workflowId, webRoot, opts.fromRelease);
  const releaseRoot = join(webRoot, releaseId);
  logs.push(`Step 0 resolveReleaseId → ${releaseId}`);

  if (!opts.skipPreflight && !opts.compileOnly) {
    const pf = await runDeployPreflight({ workflowId });
    if (!pf.ok && !opts.forcePreflightPass) {
      const err = { ok: false, status: 412, errors: pf.errors, items: pf.items };
      if (opts.json) console.log(JSON.stringify(err));
      else console.error(JSON.stringify(err, null, 2));
      return err;
    }
    logs.push('Step 1 preflight OK');
  } else {
    logs.push('Step 1 preflight skipped');
  }

  const workflowDir = join(POLARUI_ROOT, 'workflows', workflowId);
  const lgPath = join(workflowDir, `${workflowId}.lg.json`);
  if (!existsSync(lgPath)) {
    throw new Error(`workflow not found: ${lgPath}`);
  }

  if (!existsSync(TEMPLATE_DIR)) {
    throw new Error(`template missing: ${TEMPLATE_DIR}`);
  }

  mkdirSync(webRoot, { recursive: true });
  cpSync(TEMPLATE_DIR, releaseRoot, { recursive: true });
  logs.push('Step 2 scaffoldTemplate');

  mkdirSync(join(releaseRoot, 'workflow'), { recursive: true });
  const lgRaw = readFileSync(lgPath, 'utf8');
  writeFileSync(join(releaseRoot, 'workflow/snapshot.lg.json'), lgRaw);
  logs.push('Step 3 compileWorkflowGraph');

  const lgGraph = JSON.parse(lgRaw);
  let registry = {};
  const regPath = join(workflowDir, 'registry-entry.json');
  if (existsSync(regPath)) {
    registry = JSON.parse(readFileSync(regPath, 'utf8'));
    writeFileSync(join(releaseRoot, 'manifest.registry.json'), JSON.stringify(registry, null, 2));
  }
  logs.push('Step 4 compileRegistry');

  mkdirSync(join(releaseRoot, 'config'), { recursive: true });
  const memorySchema = compileMemorySchema({ workflowDir, lgGraph });
  writeFileSync(join(releaseRoot, 'config/memory-schema.json'), JSON.stringify(memorySchema, null, 2));
  logs.push('Step 5 compileMemorySchema');

  const promptsDir = join(workflowDir, 'prompts');
  if (existsSync(promptsDir)) {
    mkdirSync(join(releaseRoot, 'prompts'), { recursive: true });
    for (const f of readdirSync(promptsDir)) {
      cpSync(join(promptsDir, f), join(releaseRoot, 'prompts', f));
    }
  }
  logs.push('Step 6 compilePrompts');

  const executors = [...new Set((lgGraph.nodes ?? []).map((n) => n.class_type))].sort();
  writeFileSync(join(releaseRoot, 'config/required-executors.json'), JSON.stringify({ executors }, null, 2));
  logs.push('Step 7 compileExecutors');

  const { manifest, config } = compileSiteConfig({
    releaseId,
    workflowId,
    releaseRoot,
    exportEntry,
    compileSteps: COMPILE_STEPS,
    workflowSnapshotRel: 'workflow/snapshot.lg.json',
    memorySchemaRel: 'config/memory-schema.json',
    registry,
    requiredExecutors: executors,
    polaruiRoot: POLARUI_ROOT,
  });
  writeFileSync(join(releaseRoot, 'site.manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(releaseRoot, 'site.config.json'), JSON.stringify(config, null, 2));
  logs.push('Step 8 compilePolarConfig');

  mkdirSync(join(releaseRoot, 'polar/injected'), { recursive: true });
  writeFileSync(
    join(releaseRoot, 'polar/injected/release.json'),
    JSON.stringify({ release_id: releaseId, workflow_id: workflowId }, null, 2),
  );
  logs.push('Step 9 patchLibreChat');

  writeFileSync(join(releaseRoot, 'EXPORT.log'), logs.join('\n') + '\n');
  const verification = verifyRelease(releaseRoot);
  if (!verification.ok) {
    throw new Error(`verify failed: ${verification.errors.join(', ')}`);
  }
  logs.push('Step 10 verifyRelease OK');
  writeFileSync(join(releaseRoot, 'EXPORT.log'), logs.join('\n') + '\n');

  let deploy = null;
  if (!opts.compileOnly) {
    logs.push('Step 11 claimPorts → PolarPort');
    deploy = await deployWebRelease({
      releaseRoot,
      releaseId,
      polaruiRoot: POLARUI_ROOT,
      startLibreChat: opts.startLibreChat !== false,
    });
    logs.push(`Step 11 PolarPort api=${deploy.api_port} lc=${deploy.librechat_port ?? 'n/a'}`);
    logs.push(`Step 12 PolarProcess start → ${deploy.service_id}`);
    writeFileSync(join(releaseRoot, 'EXPORT.log'), logs.join('\n') + '\n');
  } else {
    logs.push('Step 11-12 deploy skipped (compile-only)');
    writeFileSync(join(releaseRoot, 'EXPORT.log'), logs.join('\n') + '\n');
  }

  const readmePath = join(releaseRoot, 'README.md');
  if (existsSync(readmePath)) {
    let readme = readFileSync(readmePath, 'utf8');
    if (!readme.includes(releaseId)) {
      readme += `\n\n## Release\n\n- **release_id**: \`${releaseId}\`\n`;
      writeFileSync(readmePath, readme);
    }
  }

  const result = {
    ok: true,
    release_id: releaseId,
    release_path: releaseRoot,
    manifest,
    compile_steps: COMPILE_STEPS,
    deploy,
  };

  if (opts.json) console.log(JSON.stringify(result));
  else if (!opts.silent) console.log(JSON.stringify(result, null, 2));

  return result;
}

import { pathToFileURL } from 'node:url';
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv);
  if (!args.workflow) {
    console.error('Usage: node scripts/export-release.mjs --workflow <id> [--from-release x] [--compile-only] [--skip-preflight] [--json]');
    process.exit(1);
  }
  try {
    const r = await exportRelease(args);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  }
}

export default exportRelease;
