/**
 * Web release export — dual entry (CLI + PolarUI Web).
 * (No shebang: this module is imported by vite.config.mjs; esbuild inlines
 * it when bundling the config and a mid-bundle `#!` is a syntax error.
 * All CLI entries invoke it as `node scripts/export-release.mjs`.)
 *
 * Pipeline properties (refactor 2026-07-09):
 * - Atomic: compiles into a hidden staging dir, renames to the final
 *   release dir only after verify passes. Failures never leave a
 *   half-built release behind.
 * - Fast scaffold: template copy uses APFS copy-on-write clones
 *   (COPYFILE_FICLONE) so the 1.4 GB template costs ~0 disk and time.
 * - Structured logging: every step is timed and recorded to EXPORT.log
 *   (human) + EXPORT.log.json (machine).
 * - Unified result contract: always resolves to
 *   { ok, stage?, error?, … } — callers map stage → exit code / HTTP status.
 *
 * @see docs/WEB_EXPORT.md
 */
import { constants, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runDeployPreflight } from '../lib/deploy-preflight.mjs';
import { compileMemorySchema } from './compile-memory-schema.mjs';
import { compileSiteConfig } from './compile-site-config.mjs';
import { loadHttpWorkflowDeclarations, parseHttpWorkflowCliArgs } from './http-workflows.mjs';
import { patchLibreChatHttpWorkflows } from './patch-librechat-http-workflows.mjs';
import { verifyRelease } from './verify-release.mjs';
import { verifyOrthogonality } from './verify-orthogonality.mjs';
import { deployWebRelease } from './deploy-web-release.mjs';
import { graphNodeTypes, resolveWorkflowGraphPath } from './graph-utils.mjs';
import { resolveTemplateSource } from './native-template.mjs';
import { compileProductManifest } from './compile-product-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLARUI_ROOT = join(__dirname, '..');
const WEB_ROOT = process.env.POLAR_WEB_ROOT ?? join(process.env.HOME ?? '~', 'Desktop/Web_related');
const STAGING_PREFIX = '.staging-';

const COMPILE_STEPS = ['graph', 'registry', 'memory-schema', 'prompts', 'executors', 'config', 'patch', 'verify', 'ports', 'deploy'];

export function parseArgs(argv) {
  const out = {
    workflow: '',
    fromRelease: '',
    compileOnly: false,
    skipPreflight: false,
    json: false,
    exportEntry: 'cli',
    templateFlavor: 'legacy',
    databaseMode: undefined,
    httpWorkflows: parseHttpWorkflowCliArgs(argv),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow') out.workflow = argv[++i];
    else if (a === '--from-release') out.fromRelease = argv[++i];
    else if (a === '--compile-only') out.compileOnly = true;
    else if (a === '--skip-preflight') out.skipPreflight = true;
    else if (a === '--json') out.json = true;
    else if (a === '--export-entry') out.exportEntry = argv[++i];
    else if (a === '--template-flavor') out.templateFlavor = argv[++i];
    else if (a === '--database-mode') out.databaseMode = argv[++i];
    else if (a === '--http-workflow') i++; // consumed by parseHttpWorkflowCliArgs
  }
  return out;
}

/**
 * Next available release id, numeric increment:
 * base → base_1 → base_2 → … (never base_1_1).
 *
 * `fromRelease` (e.g. "taoci-outreach_1") is reduced to its base name so
 * branching from an old release still lands on the next free number.
 * Staging leftovers are invisible to naming (dot-prefixed).
 *
 * @param {string} workflowId @param {string} webRoot @param {string} [fromRelease]
 */
export function resolveReleaseId(workflowId, webRoot, fromRelease) {
  // Only fromRelease gets its increment suffixes stripped — a workflow id
  // that legitimately ends in _N must stay untouched.
  const base = fromRelease ? (fromRelease.replace(/(_\d+)+$/, '') || fromRelease) : workflowId;
  if (!existsSync(join(webRoot, base))) return base;
  let n = 1;
  if (existsSync(webRoot)) {
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)$`);
    for (const name of readdirSync(webRoot)) {
      const m = name.match(re);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
  }
  return `${base}_${n}`;
}

/** Step logger: collects timed entries, flushes text + JSON after every step. */
function createStepLog(getRoot) {
  const entries = [];
  const startedAt = new Date().toISOString();
  const flush = () => {
    const root = getRoot();
    if (!root || !existsSync(root)) return;
    const text = entries
      .map((e) => `[${e.status}] Step ${e.index} ${e.title}${e.ms != null ? ` (${e.ms}ms)` : ''}${e.detail ? ` · ${e.detail}` : ''}`)
      .join('\n');
    writeFileSync(join(root, 'EXPORT.log'), text + '\n');
    writeFileSync(join(root, 'EXPORT.log.json'), JSON.stringify({ started_at: startedAt, steps: entries }, null, 2));
  };
  return {
    entries,
    record(entry) {
      entries.push(entry);
      flush();
    },
    flush,
  };
}

/**
 * Run one named pipeline step with timing + logging.
 * Throws a stage-tagged error on failure so the caller can report `stage`.
 */
async function runStep(log, index, id, title, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    log.record({ index, id, title, status: 'ok', ms: Date.now() - t0, detail: detail ?? '' });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    log.record({ index, id, title, status: 'fail', ms: Date.now() - t0, detail: err.message });
    err.stage = err.stage ?? id;
    throw err;
  }
}

/**
 * Export a workflow as a frozen web release.
 *
 * Resolves with `{ ok: true, release_id, release_path, manifest, deploy }`
 * or `{ ok: false, stage, error, … }`. Only programmer errors throw.
 *
 * @param {object} opts
 */
export async function exportRelease(opts) {
  const workflowId = opts.workflow;
  const webRoot = opts.webRoot ?? WEB_ROOT;
  const templateFlavor = opts.templateFlavor ?? 'legacy';
  const templateDir = opts.templateDir ?? resolveTemplateSource({
    flavor: templateFlavor,
    polaruiRoot: POLARUI_ROOT,
    webRoot: opts.templateWebRoot ?? WEB_ROOT,
  });
  const exportEntry = opts.exportEntry ?? 'cli';

  const emit = (result) => {
    if (opts.json) console.log(JSON.stringify(result));
    else if (!opts.silent) console.log(JSON.stringify(result, null, 2));
    return result;
  };

  // ---- Input validation (before touching the filesystem) ----
  if (!workflowId) {
    return emit({ ok: false, stage: 'input', error: 'workflow id is required' });
  }
  const workflowDir = join(POLARUI_ROOT, 'workflows', workflowId);
  const graphPath = resolveWorkflowGraphPath(workflowDir, workflowId);
  if (!graphPath) {
    return emit({ ok: false, stage: 'input', error: `workflow not found: ${workflowDir}/${workflowId}.json` });
  }
  if (!existsSync(templateDir)) {
    return emit({ ok: false, stage: 'input', error: `template missing: ${templateDir}` });
  }
  let lgGraph;
  const lgRaw = readFileSync(graphPath, 'utf8');
  try {
    lgGraph = JSON.parse(lgRaw);
  } catch (e) {
    return emit({ ok: false, stage: 'input', error: `workflow graph is not valid JSON: ${e.message}` });
  }

  // ---- Step 1: preflight (unchanged contract: 412 + errors list) ----
  if (!opts.skipPreflight && !opts.compileOnly) {
    const pf = await runDeployPreflight({ workflowId });
    if (!pf.ok && !opts.forcePreflightPass) {
      return emit({ ok: false, stage: 'preflight', status: 412, errors: pf.errors, items: pf.items });
    }
  }

  const releaseId = resolveReleaseId(workflowId, webRoot, opts.fromRelease);
  const releaseRoot = join(webRoot, releaseId);
  const stagingRoot = join(webRoot, `${STAGING_PREFIX}${releaseId}-${process.pid}`);

  // Compile into staging; promote to releaseRoot only after verify.
  let promoted = false;
  const log = createStepLog(() => (promoted ? releaseRoot : stagingRoot));

  try {
    mkdirSync(webRoot, { recursive: true });

    await runStep(log, 0, 'resolve-id', 'resolveReleaseId', () => `${releaseId} (staging ${STAGING_PREFIX}…)`);

    await runStep(log, 1, 'preflight', 'deploy preflight', () =>
      opts.skipPreflight || opts.compileOnly ? 'skipped' : 'ok',
    );

    await runStep(log, 2, 'scaffold', 'scaffoldTemplate (CoW clone, no node_modules)', () => {
      // COPYFILE_FICLONE → APFS clonefile when available, silent fallback to
      // a regular copy elsewhere — no data duplication for the big template.
      // node_modules are build-time only (LibreChat runs from its Docker
      // image; polar/server.mjs is stdlib-only) and are excluded: they are
      // 87% of the template's 155k files. Rebuilding the client inside a
      // release requires an `npm ci` in upstream/librechat first.
      cpSync(templateDir, stagingRoot, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
        filter: (src) => !/\/node_modules(\/|$)/.test(src),
      });
      return `${templateDir} (node_modules excluded)`;
    });

    await runStep(log, 3, 'graph', 'compileWorkflowGraph', () => {
      mkdirSync(join(stagingRoot, 'workflow'), { recursive: true });
      writeFileSync(join(stagingRoot, 'workflow/snapshot.json'), lgRaw);
      return 'workflow/snapshot.json';
    });

    let registry = {};
    await runStep(log, 4, 'registry', 'compileRegistry', () => {
      const regPath = join(workflowDir, 'registry-entry.json');
      if (!existsSync(regPath)) return 'no registry-entry.json';
      registry = JSON.parse(readFileSync(regPath, 'utf8'));
      // http_workflows live in site.config — strip so registry catalog stays clean
      if (registry && typeof registry === 'object' && 'http_workflows' in registry) {
        const { http_workflows: _hw, ...rest } = registry;
        registry = rest;
      }
      writeFileSync(join(stagingRoot, 'manifest.registry.json'), JSON.stringify(registry, null, 2));
      return 'manifest.registry.json';
    });

    let httpWorkflows = [];
    await runStep(log, 4.5, 'http-workflows', 'loadHttpWorkflows', () => {
      httpWorkflows = loadHttpWorkflowDeclarations({
        workflowDir,
        cliWorkflows: opts.httpWorkflows ?? [],
      });
      if (httpWorkflows.length === 0) return 'none';
      mkdirSync(join(stagingRoot, 'config'), { recursive: true });
      writeFileSync(
        join(stagingRoot, 'config/http-workflows.json'),
        JSON.stringify(httpWorkflows, null, 2),
      );
      return `${httpWorkflows.length} workflow(s)`;
    });

    await runStep(log, 5, 'memory-schema', 'compileMemorySchema', () => {
      mkdirSync(join(stagingRoot, 'config'), { recursive: true });
      const memorySchema = compileMemorySchema({ workflowDir, lgGraph });
      writeFileSync(join(stagingRoot, 'config/memory-schema.json'), JSON.stringify(memorySchema, null, 2));
      return 'config/memory-schema.json';
    });

    await runStep(log, 6, 'prompts', 'compilePrompts', () => {
      const promptsDir = join(workflowDir, 'prompts');
      if (!existsSync(promptsDir)) return 'no prompts/';
      mkdirSync(join(stagingRoot, 'prompts'), { recursive: true });
      let count = 0;
      for (const f of readdirSync(promptsDir)) {
        cpSync(join(promptsDir, f), join(stagingRoot, 'prompts', f));
        count++;
      }
      return `${count} file(s)`;
    });

    let executors = [];
    await runStep(log, 7, 'executors', 'compileExecutors', () => {
      executors = graphNodeTypes(lgGraph);
      if (executors.length === 0) {
        throw new Error('no node class_type found in graph — unsupported workflow graph shape?');
      }
      writeFileSync(join(stagingRoot, 'config/required-executors.json'), JSON.stringify({ executors }, null, 2));
      return executors.join(',');
    });

    let manifest;
    await runStep(log, 8, 'config', 'compilePolarConfig', () => {
      const compiled = compileSiteConfig({
        releaseId,
        workflowId,
        releaseRoot: stagingRoot,
        exportEntry,
        compileSteps: COMPILE_STEPS,
        workflowSnapshotRel: 'workflow/snapshot.json',
        memorySchemaRel: 'config/memory-schema.json',
        registry,
        requiredExecutors: executors,
        polaruiRoot: POLARUI_ROOT,
        httpWorkflows,
        templateFlavor,
        databaseMode: opts.databaseMode,
      });
      manifest = compiled.manifest;
      // web_root must point at the final location, not the staging dir.
      manifest.web_root = releaseRoot;
      writeFileSync(join(stagingRoot, 'site.manifest.json'), JSON.stringify(manifest, null, 2));
      writeFileSync(join(stagingRoot, 'site.config.json'), JSON.stringify(compiled.config, null, 2));
      return httpWorkflows.length
        ? `site.manifest.json + site.config.json (http_workflows=${httpWorkflows.length})`
        : 'site.manifest.json + site.config.json';
    });

    if (templateFlavor === 'native') {
      await runStep(log, 8.5, 'product-manifest', 'compileProductManifest', async () => {
        const productManifest = await compileProductManifest({ workflowDir, workflowId, releaseId });
        writeFileSync(
          join(stagingRoot, 'product.manifest.json'),
          JSON.stringify(productManifest, null, 2),
        );
        return 'product.manifest.json';
      });
    }

    if (templateFlavor === 'legacy') {
      await runStep(log, 9, 'patch', 'patchLibreChat (polar/injected + http modelSpecs)', () => {
        mkdirSync(join(stagingRoot, 'polar/injected'), { recursive: true });
        writeFileSync(
          join(stagingRoot, 'polar/injected/release.json'),
          JSON.stringify({ release_id: releaseId, workflow_id: workflowId }, null, 2),
        );
        const readmePath = join(stagingRoot, 'README.md');
        if (existsSync(readmePath)) {
          const readme = readFileSync(readmePath, 'utf8');
          if (!readme.includes(releaseId)) {
            writeFileSync(readmePath, `${readme}\n\n## Release\n\n- **release_id**: \`${releaseId}\`\n`);
          }
        }
        let patchDetail = 'polar/injected/release.json';
        const lcYamlPath = join(stagingRoot, 'librechat.yaml');
        if (httpWorkflows.length > 0 && existsSync(lcYamlPath)) {
          const patched = patchLibreChatHttpWorkflows(readFileSync(lcYamlPath, 'utf8'), httpWorkflows);
          writeFileSync(lcYamlPath, patched.yaml);
          patchDetail += ` + modelSpecs(+${patched.added})`;
        }
        return patchDetail;
      });
    } else {
      log.record({ index: 9, id: 'patch', title: 'legacy patch', status: 'skip', ms: 0, detail: 'native template' });
    }

    await runStep(log, 10, 'verify', 'verifyRelease', () => {
      const verification = verifyRelease(stagingRoot);
      if (!verification.ok) throw new Error(verification.errors.join(', '));
      return `${verification.checked} check(s)`;
    });

    await runStep(log, 10.5, 'orthogonality', 'verifyOrthogonality', () => {
      if (opts.skipVerify) return 'skipped';
      const verification = verifyOrthogonality(stagingRoot);
      if (!verification.ok) throw new Error(verification.errors.join('\n'));
      return `${verification.checked} check(s)`;
    });

    // ---- Promote: staging → final dir (atomic on same volume) ----
    if (existsSync(releaseRoot)) {
      // A concurrent export claimed the name after we resolved it.
      throw Object.assign(new Error(`release dir appeared during compile: ${releaseRoot}`), { stage: 'promote' });
    }
    renameSync(stagingRoot, releaseRoot);
    promoted = true;
    log.record({ index: 11, id: 'promote', title: 'staging → release dir', status: 'ok', ms: 0, detail: releaseRoot });

    // ---- Deploy (Steps 11–12) — after promote so paths are final ----
    let deploy = null;
    if (!opts.compileOnly) {
      try {
        await runStep(log, 11, 'deploy', 'PolarPort claim + PolarProcess start', async () => {
          deploy = await deployWebRelease({
            releaseRoot,
            releaseId,
            polaruiRoot: POLARUI_ROOT,
            startLibreChat: opts.startLibreChat !== false,
            databaseMode: opts.databaseMode,
          });
          return templateFlavor === 'native'
            ? `web=${deploy.web_port} service=${deploy.service_id}`
            : `api=${deploy.api_port} lc=${deploy.librechat_port ?? 'n/a'} service=${deploy.service_id}`;
        });
      } catch (e) {
        // Release is compiled and valid — keep it, report deploy failure.
        return emit({
          ok: false,
          stage: 'deploy',
          error: e.message,
          release_id: releaseId,
          release_path: releaseRoot,
          manifest,
          compile_steps: COMPILE_STEPS,
        });
      }
    } else {
      log.record({ index: 11, id: 'deploy', title: 'deploy', status: 'skip', ms: 0, detail: 'compile-only' });
    }

    return emit({
      ok: true,
      release_id: releaseId,
      release_path: releaseRoot,
      manifest,
      compile_steps: COMPILE_STEPS,
      deploy,
      template_flavor: templateFlavor,
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    return emit({ ok: false, stage: err.stage ?? 'compile', error: err.message, release_id: releaseId });
  } finally {
    // Staging never survives: promoted → already renamed; failed → removed.
    if (!promoted && existsSync(stagingRoot)) {
      rmSync(stagingRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = parseArgs(process.argv);
  if (!args.workflow) {
    console.error(
      'Usage: node scripts/export-release.mjs --workflow <id> [--from-release x] [--template-flavor native|legacy] [--database-mode bundled|external] [--compile-only] [--skip-preflight] [--json] [--http-workflow \'<json>\']…',
    );
    process.exit(1);
  }
  const r = await exportRelease(args);
  process.exit(r.ok ? 0 : 1);
}

export default exportRelease;
