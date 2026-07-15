import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const manifest = {
  contract_version: '1.0',
  product: { id: 'demo', name: 'Demo', context_label: '情境', route_label: '路线' },
  workflow: { id: 'demo', endpoint: 'http://127.0.0.1:8065/run/demo/flow.json' },
  stages: [{ key: 'work', label: '开始工作', component_key: 'generic_chat', internal_states: ['start'], actions: [] }],
};

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('native API', () => {
  it('reports health without exposing workflow internals', async () => {
    const app = buildApp({ manifest, staticRoot: null });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: 'polar-web' });
  });

  it('returns the validated product manifest', async () => {
    const app = buildApp({ manifest, staticRoot: null });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(response.statusCode).toBe(200);
    expect(response.json().manifest.product.id).toBe('demo');
  });

  it('rejects an invalid manifest at startup', () => {
    expect(() => buildApp({ manifest: { ...manifest, stages: [] }, staticRoot: null })).toThrow();
  });

  it('sanitizes unexpected authentication service failures', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://polar:polar@127.0.0.1:5432/polar',
      AUTH_PEPPER: 'test-pepper-with-at-least-32-characters',
      PUBLIC_APP_ORIGIN: 'http://127.0.0.1:3920',
      COOKIE_SECURE: 'false',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_FROM: 'Demo <no-reply@example.test>',
    });
    const app = buildApp({
      manifest,
      staticRoot: null,
      config,
      authService: {
        async register() { throw new Error('database at postgres.internal:5432 failed'); },
      } as any,
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: 'http://127.0.0.1:3920' },
      payload: { email: 'reader@example.com', username: 'reader', password: 'correct-horse-battery-staple' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: 'AUTH_SERVICE_UNAVAILABLE' } });
    expect(response.body).not.toContain('postgres.internal');
  });
});
