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

const NATIVE_REQUIRED = [
  'product.manifest.json',
  'Dockerfile',
  '.env.example',
  'compose.yml',
  'compose.external-db.yml',
  'db/migrations/0001_identity.sql',
  'db/migrations/0002_workflow_domain.sql',
  'db/migrations/0003_workflow_commands.sql',
  'db/migrations/0004_assets_memory_archive.sql',
  'apps/api/src/domain/service.ts',
  'apps/api/src/commands/bridge.ts',
  'apps/api/src/commands/service.ts',
  'apps/api/src/routes/domain.ts',
  'apps/api/src/routes/commands.ts',
  'apps/api/src/assets/storage.ts',
  'apps/api/src/routes/assets.ts',
  'apps/api/src/archive/import-librechat.ts',
  'apps/api/src/routes/archive.ts',
  'apps/api/src/routes/memory.ts',
  'apps/web/src/commands/api.ts',
  'apps/web/src/stages/StageWorkspace.tsx',
];
const NATIVE_FORBIDDEN = ['librechat.yaml', 'upstream/librechat', 'scripts/build-librechat.mjs'];

const JSON_FILES = [
  'site.manifest.json',
  'site.config.json',
  'workflow/snapshot.json',
  'config/memory-schema.json',
  'config/required-executors.json',
  'product.manifest.json',
];

function composeServiceBlock(source, service) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function isPlaceholderSecret(value) {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '');
  return normalized === ''
    || normalized.startsWith('${')
    || /change-me|replace-with|example|placeholder|generate|<.*>/i.test(normalized);
}

function verifyComposeSecretReferences(source, label, errors) {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(DATABASE_URL|AUTH_PEPPER|POSTGRES_PASSWORD|SMTP_PASSWORD)\s*:\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    if (!value.includes('${') && !isPlaceholderSecret(value)) {
      errors.push(`embedded usable ${match[1]} in ${label} compose`);
    }
  }
}

function verifyNativeIdentity(releaseRoot, errors) {
  const bundledPath = join(releaseRoot, 'compose.yml');
  const externalPath = join(releaseRoot, 'compose.external-db.yml');
  const envPath = join(releaseRoot, '.env.example');

  if (existsSync(bundledPath)) {
    const compose = readFileSync(bundledPath, 'utf8');
    verifyComposeSecretReferences(compose, 'bundled', errors);
    const postgres = composeServiceBlock(compose, 'postgres');
    if (!composeServiceBlock(compose, 'web')) errors.push('native compose missing web service');
    if (!postgres) errors.push('native compose missing postgres service');
    if (/^\s+ports:\s*$/m.test(postgres)) {
      errors.push('native compose must not publish a PostgreSQL port');
    }
    for (const name of ['DATABASE_URL', 'AUTH_PEPPER', 'PUBLIC_APP_ORIGIN', 'SMTP_HOST']) {
      if (!compose.includes(name)) errors.push(`native compose missing auth configuration: ${name}`);
    }
    if (!compose.includes('OBJECT_STORE_DIRECTORY')) errors.push('native compose missing object storage configuration');
    if (!compose.includes('/data/objects')) errors.push('native compose missing persistent object storage volume');
    if (/mongo(db)?\s*:/i.test(compose) || /image:\s*[^\n]*mongo/i.test(compose)) {
      errors.push('forbidden MongoDB runtime in native compose');
    }
  }

  if (existsSync(externalPath)) {
    const compose = readFileSync(externalPath, 'utf8');
    verifyComposeSecretReferences(compose, 'external database', errors);
    if (!composeServiceBlock(compose, 'web')) errors.push('external database compose missing web service');
    if (composeServiceBlock(compose, 'postgres')) errors.push('external database compose must not define postgres');
    for (const name of ['DATABASE_URL', 'AUTH_PEPPER', 'PUBLIC_APP_ORIGIN', 'SMTP_HOST']) {
      if (!compose.includes(name)) errors.push(`external database compose missing required configuration: ${name}`);
    }
    if (!compose.includes('OBJECT_STORE_DIRECTORY')) errors.push('external database compose missing object storage configuration');
  }

  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(AUTH_PEPPER|SMTP_PASSWORD|POSTGRES_PASSWORD)\s*=\s*(.*)$/);
      if (match && !isPlaceholderSecret(match[2])) {
        errors.push(`embedded usable identity secret in .env.example: ${match[1]}`);
      }
    }
  }

  const packagePath = join(releaseRoot, 'package.json');
  if (existsSync(packagePath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
      const dependencies = { ...(packageJson.dependencies ?? {}), ...(packageJson.optionalDependencies ?? {}) };
      if (Object.keys(dependencies).some((name) => /^(?:@librechat\/|librechat|mongodb|mongoose)$/i.test(name))) {
        errors.push('forbidden LibreChat or MongoDB dependency in native package');
      }
    } catch {
      errors.push('invalid JSON: package.json');
    }
  }
}

/**
 * @param {string} releaseRoot
 * @returns {{ ok: boolean, errors: string[], checked: number }}
 */
export function verifyRelease(releaseRoot) {
  const errors = [];
  let checked = 0;

  let templateFlavor = 'legacy';
  const manifestPath = join(releaseRoot, 'site.manifest.json');
  if (existsSync(manifestPath)) {
    try {
      templateFlavor = JSON.parse(readFileSync(manifestPath, 'utf8')).template_flavor ?? 'legacy';
    } catch {
      // The normal JSON validation below reports the malformed manifest.
    }
  }

  const required = templateFlavor === 'native'
    ? [...REQUIRED, ...NATIVE_REQUIRED]
    : REQUIRED;

  for (const rel of required) {
    checked++;
    if (!existsSync(join(releaseRoot, rel))) errors.push(`missing: ${rel}`);
  }

  if (templateFlavor === 'native') {
    for (const rel of NATIVE_FORBIDDEN) {
      checked++;
      if (existsSync(join(releaseRoot, rel))) errors.push(`forbidden in native release: ${rel}`);
    }
    verifyNativeIdentity(releaseRoot, errors);
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

  const productManifest = parsed['product.manifest.json'];
  if (templateFlavor === 'native' && manifest && productManifest) {
    checked++;
    if (productManifest.contract_version !== '1.0') {
      errors.push('product manifest contract_version must be 1.0');
    }
    if (productManifest.workflow?.id !== manifest.workflow_id) {
      errors.push(
        `workflow identity mismatch: site=${manifest.workflow_id ?? 'missing'} product=${productManifest.workflow?.id ?? 'missing'}`,
      );
    }
    const expectedProductId = String(manifest.release_id ?? '').replace(/_/g, '-');
    if (productManifest.product?.id !== expectedProductId) {
      errors.push(
        `product identity mismatch: release=${expectedProductId || 'missing'} product=${productManifest.product?.id ?? 'missing'}`,
      );
    }
    if (typeof productManifest.workflow?.endpoint !== 'string' || !productManifest.workflow.endpoint) {
      errors.push('product manifest missing workflow endpoint');
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
