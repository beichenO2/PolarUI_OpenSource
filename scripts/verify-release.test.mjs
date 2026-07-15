import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyRelease } from './verify-release.mjs';

function nativeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-release-'));
  mkdirSync(join(root, 'workflow'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  const snapshot = '{}';
  writeFileSync(join(root, 'workflow/snapshot.json'), snapshot);
  writeFileSync(join(root, 'config/memory-schema.json'), '{}');
  writeFileSync(join(root, 'config/required-executors.json'), '{"executors":["LLM"]}');
  writeFileSync(join(root, 'site.config.json'), '{"template_flavor":"native"}');
  writeFileSync(join(root, 'product.manifest.json'), '{"contract_version":"1.0"}');
  writeFileSync(join(root, 'Dockerfile'), 'FROM node:22-alpine\n');
  mkdirSync(join(root, 'db/migrations'), { recursive: true });
  writeFileSync(join(root, 'db/migrations/0001_identity.sql'), 'CREATE TABLE users(id uuid primary key);\n');
  writeFileSync(join(root, 'db/migrations/0002_workflow_domain.sql'), 'CREATE TABLE contexts(id uuid primary key);\n');
  writeFileSync(join(root, 'db/migrations/0003_workflow_commands.sql'), 'CREATE TABLE workflow_commands(id uuid primary key);\n');
  mkdirSync(join(root, 'apps/api/src/domain'), { recursive: true });
  mkdirSync(join(root, 'apps/api/src/commands'), { recursive: true });
  mkdirSync(join(root, 'apps/api/src/routes'), { recursive: true });
  mkdirSync(join(root, 'apps/web/src/commands'), { recursive: true });
  writeFileSync(join(root, 'apps/api/src/domain/service.ts'), 'export const domain = true;\n');
  writeFileSync(join(root, 'apps/api/src/routes/domain.ts'), 'export const routes = true;\n');
  writeFileSync(join(root, 'apps/api/src/commands/bridge.ts'), 'export const bridge = true;\n');
  writeFileSync(join(root, 'apps/api/src/commands/service.ts'), 'export const commands = true;\n');
  writeFileSync(join(root, 'apps/api/src/routes/commands.ts'), 'export const routes = true;\n');
  writeFileSync(join(root, 'apps/web/src/commands/api.ts'), 'export const commands = true;\n');
  writeFileSync(join(root, 'compose.yml'), `services:
  web:
    environment:
      DATABASE_URL: postgresql://polar:change-me@postgres:5432/polar
      AUTH_PEPPER: \${AUTH_PEPPER:?AUTH_PEPPER is required}
      PUBLIC_APP_ORIGIN: \${PUBLIC_APP_ORIGIN:?PUBLIC_APP_ORIGIN is required}
      SMTP_HOST: mailpit
    ports:
      - "127.0.0.1:3920:3920"
  postgres:
    image: postgres:16-alpine
    volumes:
      - polar-data:/var/lib/postgresql/data
volumes:
  polar-data:
`);
  writeFileSync(join(root, 'compose.external-db.yml'), `services:
  web:
    environment:
      DATABASE_URL: \${DATABASE_URL:?DATABASE_URL is required}
      AUTH_PEPPER: \${AUTH_PEPPER:?AUTH_PEPPER is required}
      PUBLIC_APP_ORIGIN: \${PUBLIC_APP_ORIGIN:?PUBLIC_APP_ORIGIN is required}
      SMTP_HOST: \${SMTP_HOST:?SMTP_HOST is required}
`);
  writeFileSync(join(root, '.env.example'), [
    'DATABASE_URL=postgresql://polar:change-me@postgres:5432/polar',
    'AUTH_PEPPER=replace-with-at-least-32-random-characters',
    'PUBLIC_APP_ORIGIN=http://127.0.0.1:3920',
    'SMTP_HOST=mailpit',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'README.md'), '# Native\n');
  writeFileSync(join(root, 'EXPORT.log'), 'ok\n');
  writeFileSync(join(root, 'site.manifest.json'), JSON.stringify({
    release_id: 'native', workflow_id: 'demo', template_flavor: 'native',
    workflow_snapshot: 'workflow/snapshot.json',
    workflow_checksum: `sha256:${createHash('sha256').update(snapshot).digest('hex')}`,
    compile_steps: ['a', 'b', 'c', 'd', 'e', 'f'],
  }));
  return root;
}

test('native verification requires product manifest, identity migration, and deployment modes', () => {
  const root = nativeFixture();
  assert.equal(verifyRelease(root).ok, true);
  rmSync(join(root, 'db/migrations/0001_identity.sql'));
  const result = verifyRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('0001_identity.sql')));
});

test('native verification requires workflow domain migration and runtime modules', () => {
  const root = nativeFixture();
  rmSync(join(root, 'db/migrations/0002_workflow_domain.sql'));
  rmSync(join(root, 'apps/api/src/routes/domain.ts'));
  const result = verifyRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('0002_workflow_domain.sql')));
  assert.ok(result.errors.some((error) => error.includes('routes/domain.ts')));
});

test('native verification requires command migration and runtime modules', () => {
  const root = nativeFixture();
  for (const file of [
    'db/migrations/0003_workflow_commands.sql',
    'apps/api/src/commands/bridge.ts',
    'apps/api/src/commands/service.ts',
    'apps/api/src/routes/commands.ts',
    'apps/web/src/commands/api.ts',
  ]) {
    rmSync(join(root, file));
  }
  const result = verifyRelease(root);
  assert.equal(result.ok, false);
  for (const file of [
    '0003_workflow_commands.sql',
    'commands/bridge.ts',
    'commands/service.ts',
    'routes/commands.ts',
    'commands/api.ts',
  ]) {
    assert.ok(result.errors.some((error) => error.includes(file)), file);
  }
});

test('native verification rejects LibreChat runtime files', () => {
  const root = nativeFixture();
  writeFileSync(join(root, 'librechat.yaml'), 'version: 1\n');
  const result = verifyRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('librechat.yaml')));
});

test('native verification rejects a public PostgreSQL port', () => {
  const root = nativeFixture();
  const composePath = join(root, 'compose.yml');
  writeFileSync(composePath, readFileSync(composePath, 'utf8').replace(
    '    volumes:\n      - polar-data:/var/lib/postgresql/data',
    '    ports:\n      - "5432:5432"\n    volumes:\n      - polar-data:/var/lib/postgresql/data',
  ));
  const result = verifyRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /postgresql.*port|5432/i.test(error)));
});

test('native verification rejects embedded usable identity secrets', () => {
  const root = nativeFixture();
  writeFileSync(join(root, '.env.example'), 'AUTH_PEPPER=this-is-a-usable-secret-value-with-32-bytes\n');
  const result = verifyRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /secret|AUTH_PEPPER/i.test(error)));
});

test('native verification rejects missing authentication configuration', () => {
  const root = nativeFixture();
  const composePath = join(root, 'compose.external-db.yml');
  writeFileSync(
    composePath,
    readFileSync(composePath, 'utf8').replace(/^\s+AUTH_PEPPER:.*\n/m, ''),
  );
  const result = verifyRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('AUTH_PEPPER')));
});

test('native verification rejects usable secrets embedded in Compose', () => {
  const root = nativeFixture();
  const composePath = join(root, 'compose.external-db.yml');
  writeFileSync(
    composePath,
    readFileSync(composePath, 'utf8').replace(
      '${AUTH_PEPPER:?AUTH_PEPPER is required}',
      'hardcoded-auth-pepper-with-more-than-32-characters',
    ),
  );
  const result = verifyRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /AUTH_PEPPER.*compose|compose.*AUTH_PEPPER/i.test(error)));
});
