import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.js';
import { runCreateUser } from '../src/scripts/create-user.js';

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = configuredDatabaseUrl ?? 'postgresql://localhost/polar_test_unconfigured';
const integrationDescribe = configuredDatabaseUrl ? describe : describe.skip;
const schema = 'create_user_integration';

integrationDescribe('create-user CLI', () => {
  const adminPool = createPool(databaseUrl!);
  const url = new URL(databaseUrl!);
  url.searchParams.set('options', '-csearch_path=' + schema);
  const pool = createPool(url.toString());
  const environment = {
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    AUTH_PEPPER: 'test-pepper-with-at-least-32-characters',
    PUBLIC_APP_ORIGIN: 'http://127.0.0.1:3920',
    COOKIE_SECURE: 'false',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    SMTP_FROM: 'Demo <no-reply@example.test>',
  };

  beforeEach(async () => {
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await adminPool.query('CREATE SCHEMA ' + schema);
  });

  afterAll(async () => {
    await Promise.all([pool.end(), adminPool.end()]);
  });

  it('requires an explicit verified bypass', async () => {
    const output: string[] = [];
    const code = await runCreateUser({
      argv: ['--email', 'qa@example.com', '--username', 'qa_user', '--password', 'temporary-password'],
      environment,
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    expect(code).not.toBe(0);
    expect(output.join(' ')).toContain('--verified');
  });

  it('creates a verified admin_cli user without printing credentials', async () => {
    const output: string[] = [];
    const code = await runCreateUser({
      argv: ['--email', 'qa@example.com', '--username', 'qa_user', '--password', 'temporary-password', '--verified'],
      environment,
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    expect(code).toBe(0);
    const result = await pool.query(
      'SELECT email, username, password_hash, email_verified_at, created_via FROM users',
    );
    expect(result.rows[0]).toMatchObject({
      email: 'qa@example.com',
      username: 'qa_user',
      password_hash: expect.stringMatching(/^scrypt\$v1\$/),
      email_verified_at: expect.any(Date),
      created_via: 'admin_cli',
    });
    expect(output.join(' ')).toContain('qa_user');
    expect(output.join(' ')).not.toContain('temporary-password');
    expect(output.join(' ')).not.toContain(result.rows[0].password_hash);
  });
});
