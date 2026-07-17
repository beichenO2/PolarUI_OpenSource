import { describe, expect, it } from 'vitest';
import { digestSessionToken } from '../src/auth/tokens.js';
import { createAuthService } from '../src/auth/service.js';
import { MailDeliveryError, type VerificationMailer } from '../src/auth/mailer.js';

const now = new Date('2026-07-15T12:00:00.000Z');
const pepper = 'test-pepper-with-at-least-32-characters';

function createHarness(options: { verificationTtlSeconds?: number; sessionTtlSeconds?: number } = {}) {
  const users: any[] = [];
  const verifications: any[] = [];
  const sessions: any[] = [];
  const sent: any[] = [];
  const touches: any[] = [];
  let mailFailure = false;
  let verificationPersistenceFailure = false;

  const repository = {
    async createUser(input: any) {
      if (users.some((user) => user.emailNormalized === input.emailNormalized)) {
        return { ok: false as const, code: 'EMAIL_TAKEN' as const };
      }
      if (users.some((user) => user.usernameNormalized === input.usernameNormalized)) {
        return { ok: false as const, code: 'USERNAME_TAKEN' as const };
      }
      const user = { ...input, updatedAt: input.createdAt };
      users.push(user);
      return { ok: true as const, user };
    },
    async findUserByLoginIdentifier(identifier: string) {
      return users.find((user) =>
        user.emailNormalized === identifier || user.usernameNormalized === identifier) ?? null;
    },
    async createVerification(input: any) {
      if (verificationPersistenceFailure) throw new Error('database unavailable');
      for (const item of verifications) {
        if (item.userId === input.userId && !item.consumedAt && !item.invalidatedAt) {
          item.invalidatedAt = input.sentAt;
        }
      }
      verifications.push({ ...input, attemptCount: 0, consumedAt: null, invalidatedAt: null });
    },
    async getVerificationSendState(userId: string, since: Date) {
      const recent = verifications.filter((item) =>
        item.userId === userId && item.sentAt >= since);
      return {
        count: recent.length,
        lastSentAt: recent.at(-1)?.sentAt ?? null,
      };
    },
    async createVerificationIfAllowed(input: any) {
      const recent = verifications.filter((item) =>
        item.userId === input.userId && item.sentAt >= input.since);
      const lastSentAt = recent.at(-1)?.sentAt ?? null;
      if (
        recent.length >= input.maxCount ||
        (lastSentAt && input.sentAt.getTime() - lastSentAt.getTime() < input.minimumIntervalMs)
      ) return false;
      await repository.createVerification(input);
      return true;
    },
    async consumeVerification(input: any) {
      const item = verifications.find((candidate) =>
        candidate.userId === input.userId && !candidate.consumedAt && !candidate.invalidatedAt);
      if (!item) return { status: 'missing' as const };
      if (item.expiresAt <= input.now) return { status: 'expired' as const };
      if (item.attemptCount >= 5) return { status: 'exhausted' as const };
      if (item.codeDigest !== input.codeDigest) {
        item.attemptCount += 1;
        return item.attemptCount >= 5
          ? { status: 'exhausted' as const }
          : { status: 'invalid' as const, attemptsRemaining: 5 - item.attemptCount };
      }
      item.consumedAt = input.now;
      const user = users.find((candidate) => candidate.id === input.userId);
      user.emailVerifiedAt = input.now;
      return { status: 'verified' as const };
    },
    async createSession(input: any) {
      sessions.push(input);
    },
    async revokeSession(tokenDigest: string, revokedAt: Date) {
      const session = sessions.find((candidate) => candidate.tokenDigest === tokenDigest);
      if (session) session.revokedAt = revokedAt;
    },
    async findSessionUser(tokenDigest: string, at: Date) {
      const session = sessions.find((candidate) =>
        candidate.tokenDigest === tokenDigest &&
        !candidate.revokedAt &&
        candidate.expiresAt > at);
      if (!session) return null;
      const user = users.find((candidate) => candidate.id === session.userId);
      if (!user || user.status !== 'active') return null;
      return { id: user.id, email: user.email, username: user.username };
    },
    async touchSession(input: any) {
      touches.push(input);
      return true;
    },
  };

  const mailer: VerificationMailer = {
    async sendVerification(input) {
      if (mailFailure) throw new MailDeliveryError();
      sent.push(input);
    },
  };

  let id = 0;
  const service = createAuthService({
    repository,
    mailer,
    pepper,
    productName: 'Research Workspace',
    clock: () => now,
    createId: () => 'id-' + String(++id),
    createVerificationCode: () => '004217',
    createSessionToken: () => 'session-token-' + String(id),
    verificationTtlSeconds: options.verificationTtlSeconds,
    sessionTtlSeconds: options.sessionTtlSeconds,
  });

  return {
    service,
    users,
    verifications,
    sessions,
    sent,
    touches,
    failMail: () => { mailFailure = true; },
    failVerificationPersistence: () => { verificationPersistenceFailure = true; },
  };
}

describe('auth service', () => {
  it('provisions the configured verified demo account idempotently', async () => {
    const harness = createHarness();
    const input = {
      email: 'demo@native-web.test',
      username: 'demo',
      password: 'Demo-Workflow-2026!',
    };

    await expect(harness.service.ensureVerifiedDemoUser(input))
      .resolves.toMatchObject({ ok: true, created: true });
    await expect(harness.service.ensureVerifiedDemoUser(input))
      .resolves.toMatchObject({ ok: true, created: false });
    expect(harness.users).toHaveLength(1);
    await expect(harness.service.login({
      identifier: 'demo',
      password: input.password,
      userAgent: null,
      ipPrefix: null,
    })).resolves.toMatchObject({ ok: true });
  });

  it('registers an unverified user and sends a ten-minute code', async () => {
    const harness = createHarness();
    const result = await harness.service.register({
      email: 'Reader@example.com',
      username: 'Reader',
      password: 'correct-horse-battery-staple',
    });
    expect(result).toEqual({
      ok: true,
      verificationRequired: true,
      maskedEmail: 'R****r@example.com',
    });
    expect(harness.users[0]).toMatchObject({
      emailNormalized: 'reader@example.com',
      usernameNormalized: 'reader',
      emailVerifiedAt: null,
    });
    expect(harness.users[0].passwordHash).toMatch(/^scrypt\$v1\$/);
    expect(harness.verifications[0].expiresAt).toEqual(
      new Date(now.getTime() + 10 * 60_000),
    );
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].code).toBe('004217');
  });

  it('keeps the unverified account when SMTP fails and hides the cause', async () => {
    const harness = createHarness();
    harness.failMail();
    const result = await harness.service.register({
      email: 'reader@example.com',
      username: 'reader',
      password: 'correct-horse-battery-staple',
    });
    expect(result).toEqual({ ok: false, code: 'MAIL_DELIVERY_FAILED' });
    expect(JSON.stringify(result)).not.toContain('SMTP password');
    expect(harness.users).toHaveLength(1);
  });

  it('does not misclassify verification persistence failures as SMTP failures', async () => {
    const harness = createHarness();
    harness.failVerificationPersistence();
    await expect(harness.service.register({
      email: 'reader@example.com',
      username: 'reader',
      password: 'correct-horse-battery-staple',
    })).rejects.toThrow('database unavailable');
  });

  it('resends generically and enforces the minute and hourly limits', async () => {
    const harness = createHarness();
    await harness.service.register({
      email: 'reader@example.com',
      username: 'reader',
      password: 'correct-horse-battery-staple',
    });
    await expect(harness.service.resendVerification({ email: 'missing@example.com' }))
      .resolves.toEqual({ accepted: true });
    await expect(harness.service.resendVerification({ email: 'not-an-email' }))
      .resolves.toEqual({ accepted: true });
    await expect(harness.service.resendVerification({ email: 'reader@example.com' }))
      .resolves.toEqual({ accepted: true });
    expect(harness.sent).toHaveLength(1);
  });

  it('verifies once and rejects wrong or exhausted codes safely', async () => {
    const harness = createHarness();
    await harness.service.register({
      email: 'reader@example.com',
      username: 'reader',
      password: 'correct-horse-battery-staple',
    });
    await expect(harness.service.verifyEmail({
      email: 'reader@example.com',
      code: '000000',
    })).resolves.toMatchObject({ ok: false, code: 'INVALID_VERIFICATION_CODE' });
    await expect(harness.service.verifyEmail({
      email: 'reader@example.com',
      code: '004217',
    })).resolves.toEqual({ ok: true });
    await expect(harness.service.verifyEmail({
      email: 'reader@example.com',
      code: '004217',
    })).resolves.toMatchObject({ ok: false, code: 'INVALID_VERIFICATION_CODE' });
  });

  it('logs in by email or username and stores only the session digest', async () => {
    const harness = createHarness();
    await harness.service.register({
      email: 'reader@example.com',
      username: 'reader',
      password: 'correct-horse-battery-staple',
    });
    await harness.service.verifyEmail({ email: 'reader@example.com', code: '004217' });

    const emailLogin = await harness.service.login({
      identifier: 'READER@example.com',
      password: 'correct-horse-battery-staple',
      userAgent: 'Vitest',
      ipPrefix: null,
    });
    expect(emailLogin).toMatchObject({ ok: true, sessionToken: expect.any(String) });
    expect(harness.sessions[0].tokenDigest).toBe(
      digestSessionToken((emailLogin as any).sessionToken),
    );
    expect(harness.sessions[0].tokenDigest).not.toBe((emailLogin as any).sessionToken);

    await expect(harness.service.login({
      identifier: 'reader',
      password: 'wrong-password',
      userAgent: null,
      ipPrefix: null,
    })).resolves.toEqual({ ok: false, code: 'INVALID_CREDENTIALS' });
    await expect(harness.service.login({
      identifier: 'reader',
      password: 'correct-horse-battery-staple',
      userAgent: null,
      ipPrefix: null,
    })).resolves.toMatchObject({ ok: true });
  });

  it('revokes logout tokens and resolves current session users', async () => {
    const harness = createHarness();
    await harness.service.register({
      email: 'reader@example.com',
      username: 'reader',
      password: 'correct-horse-battery-staple',
    });
    await harness.service.verifyEmail({ email: 'reader@example.com', code: '004217' });
    const login = await harness.service.login({
      identifier: 'reader',
      password: 'correct-horse-battery-staple',
      userAgent: null,
      ipPrefix: null,
    }) as any;
    await expect(harness.service.getSessionUser(login.sessionToken))
      .resolves.toMatchObject({ username: 'reader' });
    expect(harness.touches).toHaveLength(1);
    await harness.service.logout(login.sessionToken);
    await expect(harness.service.getSessionUser(login.sessionToken)).resolves.toBeNull();
  });

  it('uses configured verification and session TTL values', async () => {
    const harness = createHarness({ verificationTtlSeconds: 120, sessionTtlSeconds: 3600 });
    await harness.service.register({
      email: 'reader@example.com',
      username: 'reader',
      password: 'correct-horse-battery-staple',
    });
    expect(harness.verifications[0].expiresAt).toEqual(new Date(now.getTime() + 120_000));
    await harness.service.verifyEmail({ email: 'reader@example.com', code: '004217' });
    await harness.service.login({
      identifier: 'reader',
      password: 'correct-horse-battery-staple',
      userAgent: null,
      ipPrefix: null,
    });
    expect(harness.sessions[0].expiresAt).toEqual(new Date(now.getTime() + 3_600_000));
  });
});
