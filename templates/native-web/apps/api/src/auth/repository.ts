import type { DatabaseError } from 'pg';
import type { DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { PublicUser, UserCreatedVia, UserStatus } from './types.js';

export interface StoredUser extends PublicUser {
  emailNormalized: string;
  usernameNormalized: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  status: UserStatus;
  createdVia: UserCreatedVia;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  id: string;
  email: string;
  emailNormalized: string;
  username: string;
  usernameNormalized: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  status: UserStatus;
  createdVia: UserCreatedVia;
  createdAt: Date;
}

export interface CreateVerificationInput {
  id: string;
  userId: string;
  codeDigest: string;
  sentAt: Date;
  expiresAt: Date;
}

export interface CreateRateLimitedVerificationInput extends CreateVerificationInput {
  since: Date;
  minimumIntervalMs: number;
  maxCount: number;
}

export interface ConsumeVerificationInput {
  userId: string;
  codeDigest: string;
  now: Date;
}

export type ConsumeVerificationResult =
  | { status: 'verified' }
  | { status: 'invalid'; attemptsRemaining: number }
  | { status: 'expired' }
  | { status: 'exhausted' }
  | { status: 'missing' };

export interface CreateSessionInput {
  id: string;
  userId: string;
  tokenDigest: string;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipPrefix: string | null;
}

interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  username: string;
  username_normalized: string;
  password_hash: string;
  email_verified_at: Date | null;
  status: UserStatus;
  created_via: UserCreatedVia;
  created_at: Date;
  updated_at: Date;
}

function mapUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    emailNormalized: row.email_normalized,
    username: row.username,
    usernameNormalized: row.username_normalized,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    status: row.status,
    createdVia: row.created_via,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof Error && 'code' in error;
}

export function createAuthRepository(pool: DatabasePool) {
  return {
    async createUser(input: CreateUserInput) {
      try {
        const result = await pool.query<UserRow>(
          'INSERT INTO users (' +
            'id, email, email_normalized, username, username_normalized, password_hash, ' +
            'email_verified_at, status, created_via, created_at, updated_at' +
          ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) ' +
          'RETURNING *',
          [
            input.id,
            input.email,
            input.emailNormalized,
            input.username,
            input.usernameNormalized,
            input.passwordHash,
            input.emailVerifiedAt,
            input.status,
            input.createdVia,
            input.createdAt,
          ],
        );
        return { ok: true as const, user: mapUser(result.rows[0]!) };
      } catch (error) {
        if (isDatabaseError(error) && error.code === '23505') {
          if (error.constraint === 'users_email_normalized_unique') {
            return { ok: false as const, code: 'EMAIL_TAKEN' as const };
          }
          if (error.constraint === 'users_username_normalized_unique') {
            return { ok: false as const, code: 'USERNAME_TAKEN' as const };
          }
        }
        throw error;
      }
    },

    async findUserByLoginIdentifier(identifierNormalized: string): Promise<StoredUser | null> {
      const result = await pool.query<UserRow>(
        'SELECT * FROM users ' +
        'WHERE email_normalized = $1 OR username_normalized = $1 ' +
        'LIMIT 1',
        [identifierNormalized],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async createVerification(input: CreateVerificationInput): Promise<void> {
      await withTransaction(pool, async (client) => {
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
        await client.query(
          'UPDATE email_verifications ' +
          'SET invalidated_at = $2 ' +
          'WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL',
          [input.userId, input.sentAt],
        );
        await client.query(
          'INSERT INTO email_verifications (' +
            'id, user_id, code_digest, sent_at, expires_at' +
          ') VALUES ($1, $2, $3, $4, $5)',
          [input.id, input.userId, input.codeDigest, input.sentAt, input.expiresAt],
        );
      });
    },

    async createVerificationIfAllowed(input: CreateRateLimitedVerificationInput): Promise<boolean> {
      return withTransaction(pool, async (client) => {
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
        const state = await client.query<{ count: number; last_sent_at: Date | null }>(
          'SELECT count(*)::int AS count, max(sent_at) AS last_sent_at ' +
          'FROM email_verifications WHERE user_id = $1 AND sent_at >= $2',
          [input.userId, input.since],
        );
        const count = state.rows[0]?.count ?? 0;
        const lastSentAt = state.rows[0]?.last_sent_at ?? null;
        if (
          count >= input.maxCount ||
          (lastSentAt && input.sentAt.getTime() - lastSentAt.getTime() < input.minimumIntervalMs)
        ) {
          return false;
        }
        await client.query(
          'UPDATE email_verifications SET invalidated_at = $2 ' +
          'WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL',
          [input.userId, input.sentAt],
        );
        await client.query(
          'INSERT INTO email_verifications (id, user_id, code_digest, sent_at, expires_at) ' +
          'VALUES ($1, $2, $3, $4, $5)',
          [input.id, input.userId, input.codeDigest, input.sentAt, input.expiresAt],
        );
        return true;
      });
    },

    async getVerificationSendState(
      userId: string,
      since: Date,
    ): Promise<{ count: number; lastSentAt: Date | null }> {
      const result = await pool.query<{ count: number; last_sent_at: Date | null }>(
        'SELECT count(*)::int AS count, max(sent_at) AS last_sent_at ' +
        'FROM email_verifications WHERE user_id = $1 AND sent_at >= $2',
        [userId, since],
      );
      return {
        count: result.rows[0]?.count ?? 0,
        lastSentAt: result.rows[0]?.last_sent_at ?? null,
      };
    },

    async consumeVerification(
      input: ConsumeVerificationInput,
    ): Promise<ConsumeVerificationResult> {
      return withTransaction(pool, async (client) => {
        const result = await client.query<{
          id: string;
          code_digest: string;
          attempt_count: number;
          expires_at: Date;
        }>(
          'SELECT id, code_digest, attempt_count, expires_at ' +
          'FROM email_verifications ' +
          'WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL ' +
          'ORDER BY sent_at DESC LIMIT 1 FOR UPDATE',
          [input.userId],
        );
        const challenge = result.rows[0];
        if (!challenge) return { status: 'missing' };
        if (challenge.attempt_count >= 5) return { status: 'exhausted' };
        if (challenge.expires_at.getTime() <= input.now.getTime()) {
          return { status: 'expired' };
        }

        if (challenge.code_digest === input.codeDigest) {
          await client.query(
            'UPDATE email_verifications SET consumed_at = $2 WHERE id = $1',
            [challenge.id, input.now],
          );
          await client.query(
            'UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2), ' +
            'updated_at = $2 WHERE id = $1',
            [input.userId, input.now],
          );
          return { status: 'verified' };
        }

        const nextAttemptCount = challenge.attempt_count + 1;
        await client.query(
          'UPDATE email_verifications SET attempt_count = $2 WHERE id = $1',
          [challenge.id, nextAttemptCount],
        );
        if (nextAttemptCount >= 5) return { status: 'exhausted' };
        return { status: 'invalid', attemptsRemaining: 5 - nextAttemptCount };
      });
    },

    async createSession(input: CreateSessionInput): Promise<void> {
      await pool.query(
        'INSERT INTO auth_sessions (' +
          'id, user_id, token_digest, created_at, last_seen_at, expires_at, user_agent, ip_prefix' +
        ') VALUES ($1, $2, $3, $4, $4, $5, $6, $7)',
        [
          input.id,
          input.userId,
          input.tokenDigest,
          input.createdAt,
          input.expiresAt,
          input.userAgent,
          input.ipPrefix,
        ],
      );
    },

    async findSessionUser(tokenDigest: string, now: Date): Promise<PublicUser | null> {
      const result = await pool.query<PublicUser>(
        'SELECT users.id, users.email, users.username ' +
        'FROM auth_sessions ' +
        'JOIN users ON users.id = auth_sessions.user_id ' +
        'WHERE auth_sessions.token_digest = $1 ' +
        'AND auth_sessions.revoked_at IS NULL ' +
        'AND auth_sessions.expires_at > $2 ' +
        "AND users.status = 'active' " +
        'LIMIT 1',
        [tokenDigest, now],
      );
      return result.rows[0] ?? null;
    },

    async revokeSession(tokenDigest: string, now: Date): Promise<void> {
      await pool.query(
        'UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE token_digest = $1',
        [tokenDigest, now],
      );
    },

    async touchSession(input: {
      tokenDigest: string;
      now: Date;
      minimumIntervalMs: number;
    }): Promise<boolean> {
      const threshold = new Date(input.now.getTime() - input.minimumIntervalMs);
      const result = await pool.query(
        'UPDATE auth_sessions SET last_seen_at = $2 ' +
        'WHERE token_digest = $1 ' +
        'AND last_seen_at <= $3 ' +
        'AND revoked_at IS NULL ' +
        'AND expires_at > $2',
        [input.tokenDigest, input.now, threshold],
      );
      return result.rowCount === 1;
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
