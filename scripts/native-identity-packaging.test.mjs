import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'templates', 'native-web');

async function readTemplateFile(fileName) {
  return readFile(join(root, fileName), 'utf8');
}

function serviceBlock(compose, serviceName) {
  const marker = new RegExp(`^  ${serviceName}:\\n`, 'm').exec(compose);
  assert.ok(marker, `expected ${serviceName} service`);
  const remainder = compose.slice(marker.index + marker[0].length);
  const end = remainder.search(/^(?:  [a-zA-Z0-9_-]+:|[a-zA-Z][a-zA-Z0-9_-]*:)/m);
  return end === -1 ? remainder : remainder.slice(0, end);
}

function serviceNames(compose) {
  const marker = 'services:\n';
  const start = compose.indexOf(marker);
  assert.notEqual(start, -1, 'expected services section');
  const remainder = compose.slice(start + marker.length);
  const end = remainder.search(/^[a-zA-Z][a-zA-Z0-9_-]*:/m);
  const services = end === -1 ? remainder : remainder.slice(0, end);
  return [...services.matchAll(/^  ([a-zA-Z0-9_-]+):/gm)].map((match) => match[1]);
}

test('bundled compose keeps PostgreSQL internal and Mailpit QA-only', async () => {
  const compose = await readTemplateFile('compose.yml');
  assert.deepEqual(serviceNames(compose), ['web', 'postgres', 'mailpit']);

  const web = serviceBlock(compose, 'web');
  const postgres = serviceBlock(compose, 'postgres');
  const mailpit = serviceBlock(compose, 'mailpit');

  assert.match(web, /^    ports:/m);
  assert.match(web, /\$\{POLAR_WEB_BIND:-127\.0\.0\.1}:\$\{POLAR_WEB_PORT:-3920}:3920/);
  assert.match(web, /DATABASE_URL:[^\n]*@postgres:5432\//);
  assert.match(web, /depends_on:[\s\S]*postgres:[\s\S]*condition: service_healthy/);
  for (const variable of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_SECURE']) {
    assert.match(web, new RegExp(`${variable}: \\$\\{${variable}:\\?`));
  }
  assert.match(web, /WORKFLOW_ENDPOINT_OVERRIDE: \$\{WORKFLOW_ENDPOINT_OVERRIDE:-\}/);
  assert.match(web, /WORKFLOW_TIMEOUT_MS: \$\{WORKFLOW_TIMEOUT_MS:-60000\}/);
  assert.doesNotMatch(postgres, /^    ports:/m);
  assert.match(postgres, /^    healthcheck:/m);
  assert.match(postgres, /pg_isready/);
  assert.match(postgres, /^    volumes:[\s\S]*polar_postgres_data:/m);
  assert.doesNotMatch(mailpit, /^    ports:/m);
  assert.match(mailpit, /^    profiles:[\s\S]*- (?:qa|development)$/m);
  assert.match(mailpit, /image: ghcr\.io\/axllent\/mailpit:v1\.27/);
  assert.match(compose, /^volumes:\n  polar_postgres_data:/m);
});

test('external database compose contains only web and requires operator configuration', async () => {
  const compose = await readTemplateFile('compose.external-db.yml');
  assert.deepEqual(serviceNames(compose), ['web']);

  const web = serviceBlock(compose, 'web');
  assert.match(web, /^    ports:/m);
  assert.match(web, /\$\{POLAR_WEB_BIND:-127\.0\.0\.1}:\$\{POLAR_WEB_PORT:-3920}:3920/);
  for (const variable of [
    'DATABASE_URL',
    'AUTH_PEPPER',
    'PUBLIC_APP_ORIGIN',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_FROM',
    'SMTP_SECURE',
  ]) {
    assert.match(web, new RegExp(`${variable}: \\$\\{${variable}:\\?`));
  }
  assert.match(web, /WORKFLOW_ENDPOINT_OVERRIDE: \$\{WORKFLOW_ENDPOINT_OVERRIDE:-\}/);
  assert.match(web, /WORKFLOW_TIMEOUT_MS: \$\{WORKFLOW_TIMEOUT_MS:-60000\}/);
  assert.doesNotMatch(compose, /^  (?:postgres|mailpit):/m);
});

test('production image includes migrations and compiled API/Web runtimes', async () => {
  const dockerfile = await readTemplateFile('Dockerfile');
  const rootPackage = JSON.parse(await readTemplateFile('package.json'));
  const apiPackage = JSON.parse(await readTemplateFile('apps/api/package.json'));
  assert.match(dockerfile, /COPY db \.\/db/);
  assert.match(dockerfile, /COPY --from=build \/app\/apps\/api\/dist \.\/apps\/api\/dist/);
  assert.match(dockerfile, /COPY --from=build \/app\/apps\/web\/dist \.\/apps\/web\/dist/);
  assert.match(dockerfile, /COPY --from=build \/app\/db\/migrations \.\/db\/migrations/);
  assert.match(dockerfile, /apps\/api\/dist\/scripts\/create-user\.js/);
  assert.match(dockerfile, /EXPOSE 3920/);
  assert.match(dockerfile, /CMD \["node", "apps\/api\/dist\/server\.js"\]/);
  assert.equal(rootPackage.scripts['user:create'], 'npm run user:create --workspace @polar/native-web-api --');
  assert.equal(apiPackage.scripts['user:create'], 'node dist/scripts/create-user.js');
  assert.match(await readTemplateFile('db/migrations/0002_workflow_domain.sql'), /CREATE TABLE contexts/);
  assert.match(await readTemplateFile('db/migrations/0003_workflow_commands.sql'), /CREATE TABLE workflow_commands/);
  assert.match(await readTemplateFile('apps/api/src/routes/domain.ts'), /\/api\/contexts/);
  assert.match(await readTemplateFile('apps/api/src/domain/service.ts'), /createDomainService/);
  assert.match(await readTemplateFile('apps/api/src/routes/commands.ts'), /\/api\/commands/);
  assert.match(await readTemplateFile('apps/api/src/commands/service.ts'), /createCommandService/);
  assert.match(await readTemplateFile('apps/api/src/commands/bridge.ts'), /createWorkflowBridge/);
  assert.match(await readTemplateFile('apps/web/src/commands/api.ts'), /streamCommandEvents/);
});

test('README documents the durable Phase 4 command contract and Phase 5 cutover', async () => {
  const readme = await readTemplateFile('README.md');

  assert.match(readme, /POST \/api\/threads\/:threadId\/commands[\s\S]*returns `202`/);
  assert.match(readme, /GET\s+\/api\/commands\/:commandId\/events/);
  assert.match(readme, /Last-Event-ID/);
  assert.match(readme, /heartbeat comments/);
  assert.match(readme, /Cache-Control: no-cache, no-transform/);
  assert.match(readme, /X-Accel-Buffering: no/);
  assert.match(readme, /WORKFLOW_ENDPOINT_OVERRIDE/);
  assert.match(readme, /WORKFLOW_TIMEOUT_MS/);
  assert.match(readme, /Idempotency-Key/);
  assert.match(readme, /never automatically retries an upstream timeout/);
  assert.match(readme, /resume_interrupt/);
  assert.match(readme, /private PolarFlow cursor stays in PostgreSQL/);
  assert.match(readme, /Phase 5 is complete/);
  assert.match(readme, /import:librechat/);
  assert.match(readme, /OBJECT_STORE_DIRECTORY/);
});
