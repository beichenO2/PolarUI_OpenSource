import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createAuthRepository } from '../src/auth/repository.js';
import { createAuthService } from '../src/auth/service.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = configuredDatabaseUrl ?? 'postgresql://localhost/polar_test_unconfigured';
const integrationDescribe = configuredDatabaseUrl ? describe : describe.skip;
const origin = 'http://127.0.0.1:3920';
const schema = 'auth_routes_integration';
const manifest = {
  contract_version: '1.0',
  product: { id: 'demo', name: 'Demo', context_label: '情境', route_label: '路线' },
  workflow: { id: 'demo', endpoint: 'http://private-workflow:8065/run' },
  stages: [{ key: 'work', label: '开始工作', component_key: 'generic_chat', internal_states: ['start'], actions: [] }],
};

integrationDescribe('auth routes', () => {
  const adminPool = createPool(databaseUrl!);
  const url = new URL(databaseUrl!);
  url.searchParams.set('options', '-csearch_path=' + schema);
  const pool = createPool(url.toString());
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await adminPool.query('CREATE SCHEMA ' + schema);
    await runMigrations({
      pool,
      migrationsDir: join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations'),
    });
    const repository = createAuthRepository(pool);
    const service = createAuthService({
      repository,
      mailer: { async sendVerification() {} },
      pepper: 'test-pepper-with-at-least-32-characters',
      productName: 'Demo',
      createVerificationCode: () => '004217',
    });
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl!,
      AUTH_PEPPER: 'test-pepper-with-at-least-32-characters',
      PUBLIC_APP_ORIGIN: origin,
      COOKIE_SECURE: 'false',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_FROM: 'Demo <no-reply@example.test>',
    });
    app = buildApp({
      manifest,
      staticRoot: null,
      config,
      authService: service,
      readiness: { check: async () => true },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([pool.end(), adminPool.end()]);
  });

  it('protects the complete registration and cookie session flow', async () => {
    const missingOrigin = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'reader@example.com', username: 'reader', password: 'correct-horse-battery-staple' },
    });
    expect(missingOrigin.statusCode).toBe(403);

    const register = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin },
      payload: { email: 'reader@example.com', username: 'reader', password: 'correct-horse-battery-staple' },
    });
    expect(register.statusCode).toBe(201);
    expect(register.body).not.toContain('004217');

    const unverified = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { identifier: 'reader', password: 'correct-horse-battery-staple' },
    });
    expect(unverified.statusCode).toBe(401);

    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/verify-email',
      headers: { origin },
      payload: { email: 'reader@example.com', code: '004217' },
    });
    expect(verify.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin, 'user-agent': 'Vitest' },
      payload: { identifier: 'READER@example.com', password: 'correct-horse-battery-staple' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toContain('polar_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: cookie!.split(';')[0]! },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({
      user: expect.objectContaining({ email: 'reader@example.com', username: 'reader' }),
    });

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin, cookie: cookie!.split(';')[0]! },
    });
    expect(logout.statusCode).toBe(204);
  });

  it('reports readiness and hides the private workflow endpoint', async () => {
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    const bootstrap = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(bootstrap.body).not.toContain('private-workflow');
    expect(bootstrap.json().manifest.workflow).toEqual({ id: 'demo' });
  });
});
