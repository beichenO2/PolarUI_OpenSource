import { randomUUID } from 'node:crypto';
import {
  IdentityValidationError,
  normalizeEmail,
  parseEmail,
  parseUsername,
} from './identifiers.js';
import { hashPassword, PasswordValidationError, verifyPassword } from './password.js';
import type {
  ConsumeVerificationResult,
  CreateSessionInput,
  CreateRateLimitedVerificationInput,
  CreateUserInput,
  CreateVerificationInput,
  StoredUser,
} from './repository.js';
import {
  digestSessionToken,
  digestVerificationCode,
  generateSessionToken,
  generateVerificationCode,
} from './tokens.js';
import type { PublicUser } from './types.js';
import { MailDeliveryError, type VerificationMailer } from './mailer.js';

const dummyPasswordHash = hashPassword('dummy-password-value');

interface AuthServiceRepository {
  createUser(input: CreateUserInput): Promise<
    { ok: true; user: StoredUser } |
    { ok: false; code: 'EMAIL_TAKEN' | 'USERNAME_TAKEN' }
  >;
  findUserByLoginIdentifier(identifierNormalized: string): Promise<StoredUser | null>;
  createVerification(input: CreateVerificationInput): Promise<void>;
  createVerificationIfAllowed(input: CreateRateLimitedVerificationInput): Promise<boolean>;
  consumeVerification(input: {
    userId: string;
    codeDigest: string;
    now: Date;
  }): Promise<ConsumeVerificationResult>;
  createSession(input: CreateSessionInput): Promise<void>;
  revokeSession(tokenDigest: string, now: Date): Promise<void>;
  findSessionUser(tokenDigest: string, now: Date): Promise<PublicUser | null>;
  touchSession(input: { tokenDigest: string; now: Date; minimumIntervalMs: number }): Promise<boolean>;
}

export interface CreateAuthServiceOptions {
  repository: AuthServiceRepository;
  mailer: VerificationMailer;
  pepper: string;
  productName: string;
  clock?: () => Date;
  createId?: () => string;
  createVerificationCode?: () => string;
  createSessionToken?: () => string;
  verificationTtlSeconds?: number;
  sessionTtlSeconds?: number;
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visible = local.length > 1 ? local[local.length - 1] : '';
  return local.slice(0, 1) + '*'.repeat(Math.max(3, local.length - 2)) +
    visible + '@' + domain;
}

export function createAuthService(options: CreateAuthServiceOptions) {
  const clock = options.clock ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const createCode = options.createVerificationCode ?? generateVerificationCode;
  const createToken = options.createSessionToken ?? generateSessionToken;
  const verificationTtlSeconds = options.verificationTtlSeconds ?? 10 * 60;
  const sessionTtlSeconds = options.sessionTtlSeconds ?? 30 * 24 * 60 * 60;

  function prepareVerification(user: StoredUser, sentAt: Date) {
    const code = createCode();
    const expiresAt = new Date(sentAt.getTime() + verificationTtlSeconds * 1_000);
    const verification = {
      id: createId(),
      userId: user.id,
      codeDigest: digestVerificationCode({
        pepper: options.pepper,
        userId: user.id,
        code,
      }),
      sentAt,
      expiresAt,
    };
    return { code, expiresAt, verification };
  }

  async function issueVerification(user: StoredUser, sentAt: Date) {
    const prepared = prepareVerification(user, sentAt);
    await options.repository.createVerification(prepared.verification);
    await options.mailer.sendVerification({
      email: user.email,
      productName: options.productName,
      code: prepared.code,
      expiresAt: prepared.expiresAt,
    });
  }

  async function prepareVerifiedUser(input: { email: string; username: string; password: string }) {
    const email = parseEmail(input.email);
    const username = parseUsername(input.username);
    return {
      email,
      username,
      passwordHash: await hashPassword(input.password),
    };
  }

  async function matchesVerifiedDemoUser(
    user: StoredUser | null,
    input: { emailNormalized: string; usernameNormalized: string; password: string },
  ) {
    return Boolean(
      user &&
      user.emailNormalized === input.emailNormalized &&
      user.usernameNormalized === input.usernameNormalized &&
      user.emailVerifiedAt &&
      user.status === 'active' &&
      await verifyPassword(input.password, user.passwordHash),
    );
  }

  return {
    async ensureVerifiedDemoUser(input: {
      email: string;
      username: string;
      password: string;
    }) {
      let prepared;
      try {
        prepared = await prepareVerifiedUser(input);
      } catch (error) {
        if (error instanceof IdentityValidationError || error instanceof PasswordValidationError) {
          return { ok: false as const, code: error.code };
        }
        throw error;
      }
      const expected = {
        emailNormalized: prepared.email.normalized,
        usernameNormalized: prepared.username.normalized,
        password: input.password,
      };
      const existing = await options.repository.findUserByLoginIdentifier(prepared.username.normalized);
      if (existing) {
        return await matchesVerifiedDemoUser(existing, expected)
          ? { ok: true as const, created: false, user: existing }
          : { ok: false as const, code: 'DEMO_USER_CONFLICT' as const };
      }
      const createdAt = clock();
      const created = await options.repository.createUser({
        id: createId(),
        email: prepared.email.value,
        emailNormalized: prepared.email.normalized,
        username: prepared.username.value,
        usernameNormalized: prepared.username.normalized,
        passwordHash: prepared.passwordHash,
        emailVerifiedAt: createdAt,
        status: 'active',
        createdVia: 'admin_cli',
        createdAt,
      });
      if (created.ok) return { ok: true as const, created: true, user: created.user };
      const raced = await options.repository.findUserByLoginIdentifier(prepared.email.normalized);
      return await matchesVerifiedDemoUser(raced, expected)
        ? { ok: true as const, created: false, user: raced! }
        : { ok: false as const, code: 'DEMO_USER_CONFLICT' as const };
    },

    async createVerifiedAdminUser(input: {
      email: string;
      username: string;
      password: string;
    }) {
      let prepared;
      try {
        prepared = await prepareVerifiedUser(input);
      } catch (error) {
        if (error instanceof IdentityValidationError || error instanceof PasswordValidationError) {
          return { ok: false as const, code: error.code };
        }
        throw error;
      }
      const createdAt = clock();
      return options.repository.createUser({
        id: createId(),
        email: prepared.email.value,
        emailNormalized: prepared.email.normalized,
        username: prepared.username.value,
        usernameNormalized: prepared.username.normalized,
        passwordHash: prepared.passwordHash,
        emailVerifiedAt: createdAt,
        status: 'active',
        createdVia: 'admin_cli',
        createdAt,
      });
    },

    async register(input: { email: string; username: string; password: string }) {
      let email;
      let username;
      let passwordHash;
      try {
        email = parseEmail(input.email);
        username = parseUsername(input.username);
        passwordHash = await hashPassword(input.password);
      } catch (error) {
        if (error instanceof IdentityValidationError || error instanceof PasswordValidationError) {
          return { ok: false as const, code: error.code };
        }
        throw error;
      }

      const createdAt = clock();
      const created = await options.repository.createUser({
        id: createId(),
        email: email.value,
        emailNormalized: email.normalized,
        username: username.value,
        usernameNormalized: username.normalized,
        passwordHash,
        emailVerifiedAt: null,
        status: 'active',
        createdVia: 'registration',
        createdAt,
      });
      if (!created.ok) return created;

      try {
        await issueVerification(created.user, createdAt);
      } catch (error) {
        if (error instanceof MailDeliveryError) {
          return { ok: false as const, code: 'MAIL_DELIVERY_FAILED' as const };
        }
        throw error;
      }
      return {
        ok: true as const,
        verificationRequired: true as const,
        maskedEmail: maskEmail(created.user.email),
      };
    },

    async resendVerification(input: { email: string }) {
      let emailNormalized;
      try {
        emailNormalized = normalizeEmail(parseEmail(input.email).value);
      } catch (error) {
        if (error instanceof IdentityValidationError) return { accepted: true as const };
        throw error;
      }
      const user = await options.repository.findUserByLoginIdentifier(emailNormalized);
      if (!user || user.emailVerifiedAt) return { accepted: true as const };

      const sentAt = clock();
      try {
        const prepared = prepareVerification(user, sentAt);
        const allowed = await options.repository.createVerificationIfAllowed({
          ...prepared.verification,
          since: new Date(sentAt.getTime() - 60 * 60_000),
          minimumIntervalMs: 60_000,
          maxCount: 5,
        });
        if (!allowed) return { accepted: true as const };
        await options.mailer.sendVerification({
          email: user.email,
          productName: options.productName,
          code: prepared.code,
          expiresAt: prepared.expiresAt,
        });
      } catch {
        return { accepted: true as const };
      }
      return { accepted: true as const };
    },

    async verifyEmail(input: { email: string; code: string }) {
      if (!/^\d{6}$/.test(input.code)) {
        return { ok: false as const, code: 'INVALID_VERIFICATION_CODE' as const };
      }
      let normalized;
      try {
        normalized = parseEmail(input.email).normalized;
      } catch {
        return { ok: false as const, code: 'INVALID_VERIFICATION_CODE' as const };
      }
      const user = await options.repository.findUserByLoginIdentifier(normalized);
      if (!user || user.emailVerifiedAt) {
        return { ok: false as const, code: 'INVALID_VERIFICATION_CODE' as const };
      }
      const result = await options.repository.consumeVerification({
        userId: user.id,
        codeDigest: digestVerificationCode({
          pepper: options.pepper,
          userId: user.id,
          code: input.code,
        }),
        now: clock(),
      });
      if (result.status === 'verified') return { ok: true as const };
      if (result.status === 'expired') {
        return { ok: false as const, code: 'VERIFICATION_EXPIRED' as const };
      }
      return { ok: false as const, code: 'INVALID_VERIFICATION_CODE' as const };
    },

    async login(input: {
      identifier: string;
      password: string;
      userAgent: string | null;
      ipPrefix: string | null;
    }) {
      let normalized: string | null = null;
      try {
        normalized = input.identifier.includes('@')
          ? parseEmail(input.identifier).normalized
          : parseUsername(input.identifier).normalized;
      } catch {
        normalized = null;
      }
      const user = normalized
        ? await options.repository.findUserByLoginIdentifier(normalized)
        : null;
      const passwordMatches = user
        ? await verifyPassword(input.password, user.passwordHash)
        : await verifyPassword(input.password, await dummyPasswordHash);
      if (
        !user ||
        !passwordMatches ||
        !user.emailVerifiedAt ||
        user.status !== 'active'
      ) {
        return { ok: false as const, code: 'INVALID_CREDENTIALS' as const };
      }

      const createdAt = clock();
      const sessionToken = createToken();
      await options.repository.createSession({
        id: createId(),
        userId: user.id,
        tokenDigest: digestSessionToken(sessionToken),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + sessionTtlSeconds * 1_000),
        userAgent: input.userAgent,
        ipPrefix: input.ipPrefix,
      });
      return {
        ok: true as const,
        sessionToken,
        user: { id: user.id, email: user.email, username: user.username },
      };
    },

    async logout(sessionToken: string) {
      await options.repository.revokeSession(digestSessionToken(sessionToken), clock());
    },

    async getSessionUser(sessionToken: string) {
      const tokenDigest = digestSessionToken(sessionToken);
      const now = clock();
      const user = await options.repository.findSessionUser(tokenDigest, now);
      if (user) {
        await options.repository.touchSession({ tokenDigest, now, minimumIntervalMs: 10 * 60_000 });
      }
      return user;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
