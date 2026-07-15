import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthRepository } from '../src/auth/repository.js';
import { hashPassword } from '../src/auth/password.js';
import { createPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
const databaseUrl = configuredDatabaseUrl ?? 'postgresql://localhost/polar_test_unconfigured';
const integrationDescribe = configuredDatabaseUrl ? describe : describe.skip;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const schemaName = 'auth_repository_integration';

function isolatedDatabaseUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.set('options', '-csearch_path=' + schemaName);
  return url.toString();
}

integrationDescribe('auth repository', () => {
  const adminPool = createPool(databaseUrl!);
  const pool = createPool(isolatedDatabaseUrl(databaseUrl!));
  const repository = createAuthRepository(pool);
  const now = new Date('2026-07-15T12:00:00.000Z');

  beforeAll(async () => {
    await pool.query('SELECT 1');
  });

  beforeEach(async () => {
    await adminPool.query('DROP SCHEMA IF EXISTS ' + schemaName + ' CASCADE');
    await adminPool.query('CREATE SCHEMA ' + schemaName);
    await runMigrations({ pool, migrationsDir });
  });

  afterAll(async () => {
    await Promise.all([pool.end(), adminPool.end()]);
  });

  async function createUser(overrides: Record<string, unknown> = {}) {
    const passwordHash = await hashPassword('correct-horse-battery-staple');
    const input = {
      id: randomUUID(),
      email: 'Reader@example.com',
      emailNormalized: 'reader@example.com',
      username: 'Reader',
      usernameNormalized: 'reader',
      passwordHash,
      emailVerifiedAt: null,
      status: 'active' as const,
      createdVia: 'registration' as const,
      createdAt: now,
      ...overrides,
    };
    const result = await repository.createUser(input);
    if (!result.ok) throw new Error(result.code);
    return result.user;
  }

  it('creates users and finds either normalized login identifier', async () => {
    const user = await createUser();
    expect(user.passwordHash).toMatch(/^scrypt\$v1\$/);
    await expect(repository.findUserByLoginIdentifier('reader@example.com'))
      .resolves.toMatchObject({ id: user.id, email: 'Reader@example.com' });
    await expect(repository.findUserByLoginIdentifier('reader'))
      .resolves.toMatchObject({ id: user.id, username: 'Reader' });
  });

  it('maps normalized email and username conflicts', async () => {
    await createUser();
    const passwordHash = await hashPassword('another-secure-password');

    await expect(repository.createUser({
      id: randomUUID(),
      email: 'READER@example.com',
      emailNormalized: 'reader@example.com',
      username: 'Other',
      usernameNormalized: 'other',
      passwordHash,
      emailVerifiedAt: null,
      status: 'active',
      createdVia: 'registration',
      createdAt: now,
    })).resolves.toEqual({ ok: false, code: 'EMAIL_TAKEN' });

    await expect(repository.createUser({
      id: randomUUID(),
      email: 'other@example.com',
      emailNormalized: 'other@example.com',
      username: 'READER',
      usernameNormalized: 'reader',
      passwordHash,
      emailVerifiedAt: null,
      status: 'active',
      createdVia: 'registration',
      createdAt: now,
    })).resolves.toEqual({ ok: false, code: 'USERNAME_TAKEN' });
  });

  it('replaces the active verification challenge', async () => {
    const user = await createUser();
    const firstId = randomUUID();
    const secondId = randomUUID();
    await repository.createVerification({
      id: firstId,
      userId: user.id,
      codeDigest: 'a'.repeat(64),
      sentAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    await repository.createVerification({
      id: secondId,
      userId: user.id,
      codeDigest: 'b'.repeat(64),
      sentAt: new Date(now.getTime() + 60_000),
      expiresAt: new Date(now.getTime() + 11 * 60_000),
    });

    const records = await pool.query(
      'SELECT id, invalidated_at FROM email_verifications ORDER BY sent_at',
    );
    expect(records.rows).toEqual([
      expect.objectContaining({ id: firstId, invalidated_at: expect.any(Date) }),
      expect.objectContaining({ id: secondId, invalidated_at: null }),
    ]);
  });

  it('serializes concurrent verification replacements for one user', async () => {
    const user = await createUser();
    const attempts = Array.from({ length: 8 }, (_, index) => repository.createVerification({
      id: randomUUID(),
      userId: user.id,
      codeDigest: String(index).padStart(64, '0'),
      sentAt: new Date(now.getTime() + index),
      expiresAt: new Date(now.getTime() + 10 * 60_000 + index),
    }));

    await expect(Promise.all(attempts)).resolves.toHaveLength(8);
    const active = await pool.query(
      'SELECT count(*)::int AS count FROM email_verifications ' +
      'WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL',
      [user.id],
    );
    expect(active.rows[0]?.count).toBe(1);
  });

  it('reports recent verification send count and latest send time', async () => {
    const user = await createUser();
    const firstSentAt = new Date(now.getTime() - 30 * 60_000);
    await repository.createVerification({
      id: randomUUID(),
      userId: user.id,
      codeDigest: 'a'.repeat(64),
      sentAt: firstSentAt,
      expiresAt: new Date(firstSentAt.getTime() + 10 * 60_000),
    });
    await repository.createVerification({
      id: randomUUID(),
      userId: user.id,
      codeDigest: 'b'.repeat(64),
      sentAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    await expect(repository.getVerificationSendState(
      user.id,
      new Date(now.getTime() - 60 * 60_000),
    )).resolves.toEqual({ count: 2, lastSentAt: now });
  });

  it('atomically allows only one concurrent resend within the cooldown', async () => {
    const user = await createUser();
    const attempts = Array.from({ length: 8 }, (_, index) =>
      repository.createVerificationIfAllowed({
        id: randomUUID(),
        userId: user.id,
        codeDigest: String(index).padStart(64, '0'),
        sentAt: now,
        expiresAt: new Date(now.getTime() + 10 * 60_000),
        since: new Date(now.getTime() - 60 * 60_000),
        minimumIntervalMs: 60_000,
        maxCount: 5,
      }));
    const results = await Promise.all(attempts);
    expect(results.filter(Boolean)).toHaveLength(1);
    const count = await pool.query(
      'SELECT count(*)::int AS count FROM email_verifications WHERE user_id = $1',
      [user.id],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('consumes a verification once and exhausts five wrong attempts atomically', async () => {
    const firstUser = await createUser();
    await repository.createVerification({
      id: randomUUID(),
      userId: firstUser.id,
      codeDigest: 'a'.repeat(64),
      sentAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    await expect(repository.consumeVerification({
      userId: firstUser.id,
      codeDigest: 'a'.repeat(64),
      now,
    })).resolves.toEqual({ status: 'verified' });
    const verifiedUser = await pool.query(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [firstUser.id],
    );
    expect(verifiedUser.rows[0]?.email_verified_at).toEqual(now);
    await expect(repository.consumeVerification({
      userId: firstUser.id,
      codeDigest: 'a'.repeat(64),
      now,
    })).resolves.toEqual({ status: 'missing' });

    const secondUser = await createUser({
      id: randomUUID(),
      email: 'second@example.com',
      emailNormalized: 'second@example.com',
      username: 'second',
      usernameNormalized: 'second',
    });
    await repository.createVerification({
      id: randomUUID(),
      userId: secondUser.id,
      codeDigest: 'b'.repeat(64),
      sentAt: now,
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(repository.consumeVerification({
        userId: secondUser.id,
        codeDigest: 'c'.repeat(64),
        now,
      })).resolves.toEqual({ status: 'invalid', attemptsRemaining: 5 - attempt });
    }
    await expect(repository.consumeVerification({
      userId: secondUser.id,
      codeDigest: 'c'.repeat(64),
      now,
    })).resolves.toEqual({ status: 'exhausted' });
    await expect(repository.consumeVerification({
      userId: secondUser.id,
      codeDigest: 'b'.repeat(64),
      now,
    })).resolves.toEqual({ status: 'exhausted' });
  });

  it('rejects expired verification challenges', async () => {
    const user = await createUser();
    await repository.createVerification({
      id: randomUUID(),
      userId: user.id,
      codeDigest: 'a'.repeat(64),
      sentAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
    });
    await expect(repository.consumeVerification({
      userId: user.id,
      codeDigest: 'a'.repeat(64),
      now: new Date(now.getTime() + 2_000),
    })).resolves.toEqual({ status: 'expired' });
  });

  it('stores session digests and rejects expired, revoked, and disabled sessions', async () => {
    const user = await createUser({ emailVerifiedAt: now });
    const tokenDigest = 'd'.repeat(64);
    await repository.createSession({
      id: randomUUID(),
      userId: user.id,
      tokenDigest,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
      userAgent: 'Vitest',
      ipPrefix: '127.0.0.0/24',
    });

    await expect(repository.findSessionUser(tokenDigest, now)).resolves.toMatchObject({
      id: user.id,
      email: user.email,
      username: user.username,
    });
    await expect(repository.findSessionUser(
      tokenDigest,
      new Date(now.getTime() + 31 * 24 * 60 * 60_000),
    )).resolves.toBeNull();

    await repository.revokeSession(tokenDigest, now);
    await repository.revokeSession(tokenDigest, now);
    await expect(repository.findSessionUser(tokenDigest, now)).resolves.toBeNull();

    const secondUser = await createUser({
      id: randomUUID(),
      email: 'disabled@example.com',
      emailNormalized: 'disabled@example.com',
      username: 'disabled',
      usernameNormalized: 'disabled',
      emailVerifiedAt: now,
    });
    const disabledDigest = 'e'.repeat(64);
    await repository.createSession({
      id: randomUUID(),
      userId: secondUser.id,
      tokenDigest: disabledDigest,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      userAgent: null,
      ipPrefix: null,
    });
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [secondUser.id]);
    await expect(repository.findSessionUser(disabledDigest, now)).resolves.toBeNull();
  });

  it('touches a session only after the configured interval', async () => {
    const user = await createUser({ emailVerifiedAt: now });
    const tokenDigest = 'f'.repeat(64);
    await repository.createSession({
      id: randomUUID(),
      userId: user.id,
      tokenDigest,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      userAgent: null,
      ipPrefix: null,
    });

    await expect(repository.touchSession({
      tokenDigest,
      now: new Date(now.getTime() + 5 * 60_000),
      minimumIntervalMs: 10 * 60_000,
    })).resolves.toBe(false);
    await expect(repository.touchSession({
      tokenDigest,
      now: new Date(now.getTime() + 11 * 60_000),
      minimumIntervalMs: 10 * 60_000,
    })).resolves.toBe(true);
  });
});
