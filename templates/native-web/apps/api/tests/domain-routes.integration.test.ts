import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { createAuthRepository } from '../src/auth/repository.js';
import { createAuthService } from '../src/auth/service.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { createDomainRepository } from '../src/domain/repository.js';
import { createDomainService } from '../src/domain/service.js';

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = configuredDatabaseUrl ?? 'postgresql://localhost/polar_test_unconfigured';
const integrationDescribe = configuredDatabaseUrl ? describe : describe.skip;
const origin = 'http://127.0.0.1:3920';
const schema = 'domain_routes_integration';
const manifest = {
  contract_version: '1.0' as const,
  product: { id: 'demo', name: 'Demo', context_label: '项目', route_label: '路线' },
  workflow: { id: 'demo', endpoint: 'http://private-workflow:8065/run' },
  stages: [
    { key: 'discover', label: '发现', component_key: 'generic_chat' as const, internal_states: ['start'], actions: [] },
    { key: 'decide', label: '决策', component_key: 'structured_form' as const, internal_states: ['waiting'], actions: [] },
  ],
};

integrationDescribe('workflow domain routes', () => {
  const adminPool = createPool(databaseUrl);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-csearch_path=' + schema);
  const pool = createPool(url.toString());
  const authRepository = createAuthRepository(pool);
  const authService = createAuthService({
    repository: authRepository,
    mailer: { async sendVerification() {} },
    pepper: 'test-pepper-with-at-least-32-characters',
    productName: 'Demo',
  });
  const domainService = createDomainService({ repository: createDomainRepository(pool), manifest });
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    AUTH_PEPPER: 'test-pepper-with-at-least-32-characters',
    PUBLIC_APP_ORIGIN: origin,
    COOKIE_SECURE: 'false',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    SMTP_FROM: 'Demo <no-reply@example.test>',
  });
  const app = buildApp({ manifest, staticRoot: null, config, authService, domainService });

  beforeAll(async () => {
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await adminPool.query('CREATE SCHEMA ' + schema);
    await runMigrations({ pool, migrationsDir: join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations') });
    for (const user of [
      { id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', username: 'owner' },
      { id: '10000000-0000-4000-8000-000000000002', email: 'other@example.test', username: 'other' },
    ]) {
      await authRepository.createUser({
        ...user,
        emailNormalized: user.email,
        usernameNormalized: user.username,
        passwordHash: await hashPassword('correct-horse-battery-staple'),
        emailVerifiedAt: new Date(),
        status: 'active',
        createdVia: 'admin_cli',
        createdAt: new Date(),
      });
    }
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await Promise.all([pool.end(), adminPool.end()]);
  });

  async function login(identifier: string) {
    const response = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin },
      payload: { identifier, password: 'correct-horse-battery-staple' },
    });
    expect(response.statusCode).toBe(200);
    return response.headers['set-cookie']!.split(';')[0]!;
  }

  it('requires authentication and same-origin mutation requests', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/contexts' })).statusCode).toBe(401);
    const cookie = await login('owner');
    const missingOrigin = await app.inject({
      method: 'POST', url: '/api/contexts', headers: { cookie }, payload: { title: 'Project' },
    });
    expect(missingOrigin.statusCode).toBe(403);
  });

  it('persists the complete hierarchy and branches from history', async () => {
    const cookie = await login('owner');
    const created = await app.inject({
      method: 'POST', url: '/api/contexts', headers: { cookie, origin }, payload: { title: '  Project Alpha  ' },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    const { context, route, checkpoint } = createdBody;

    const listed = await app.inject({ method: 'GET', url: '/api/contexts', headers: { cookie } });
    expect(listed.json().contexts).toEqual([expect.objectContaining({ id: context.id, title: 'Project Alpha' })]);

    const contextWorkspace = await app.inject({
      method: 'GET', url: `/api/contexts/${context.id}/workspace`, headers: { cookie },
    });
    expect(contextWorkspace.json().routes).toEqual([expect.objectContaining({ id: route.id })]);

    const firstThread = await app.inject({
      method: 'POST', url: `/api/routes/${route.id}/threads`, headers: { cookie, origin },
      payload: { stageKey: 'decide', title: 'Compare options' },
    });
    expect(firstThread.statusCode).toBe(201);
    const secondThread = await app.inject({
      method: 'POST', url: `/api/routes/${route.id}/threads`, headers: { cookie, origin },
      payload: { stageKey: 'decide', title: 'Revise template' },
    });
    expect(secondThread.statusCode).toBe(201);

    const workspace = await app.inject({
      method: 'GET',
      url: `/api/routes/${route.id}/workspace?stage=decide&checkpoint=${checkpoint.id}`,
      headers: { cookie },
    });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json()).toMatchObject({
      selectedStageKey: 'decide',
      isHistorical: false,
      threads: [{ title: 'Revise template' }, { title: 'Compare options' }],
    });

    const branch = await app.inject({
      method: 'POST', url: `/api/contexts/${context.id}/routes`, headers: { cookie, origin },
      payload: { sourceCheckpointId: checkpoint.id, name: 'Alternative route' },
    });
    expect(branch.statusCode).toBe(201);
    expect(branch.json()).toMatchObject({
      route: { name: 'Alternative route', originCheckpointId: checkpoint.id },
      checkpoint: { parentCheckpointId: null, reason: 'branch' },
    });
  });

  it('rejects unknown stages and hides cross-user resources', async () => {
    const ownerCookie = await login('owner');
    const otherCookie = await login('other');
    const created = await app.inject({
      method: 'POST', url: '/api/contexts', headers: { cookie: ownerCookie, origin }, payload: { title: 'Private' },
    });
    const { route } = created.json();
    const invalidStage = await app.inject({
      method: 'POST', url: `/api/routes/${route.id}/threads`, headers: { cookie: ownerCookie, origin },
      payload: { stageKey: 'missing', title: 'Nope' },
    });
    expect(invalidStage.statusCode).toBe(400);
    expect(invalidStage.json().error.code).toBe('INVALID_STAGE');
    const crossUser = await app.inject({
      method: 'GET', url: `/api/routes/${route.id}/workspace?stage=discover`, headers: { cookie: otherCookie },
    });
    expect(crossUser.statusCode).toBe(404);
    expect(crossUser.json().error.code).toBe('NOT_FOUND');
  });
});
