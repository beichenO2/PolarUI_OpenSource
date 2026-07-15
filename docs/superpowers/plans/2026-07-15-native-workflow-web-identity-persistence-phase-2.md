# Native Workflow Web Identity and PostgreSQL Persistence Phase 2 Implementation Plan

> **Execution mode:** Use ordinary task-level SubAgents coordinated directly by the Main Agent. Do not invoke superpowers:subagent-driven-development, superpowers:executing-plans, or any other Superpowers execution workflow. Steps use checkbox syntax for tracking.

**Goal:** Add a production-grade native identity system with PostgreSQL migrations, six-digit email verification, email-or-username login, persistent opaque sessions, an administrator account CLI, authenticated Web pages, and real-container PostgreSQL/Mailpit browser QA.

**Architecture:** Extend the tracked native template with explicit SQL migrations, focused repository and service modules, a same-origin Fastify authentication API, and a React AuthGate. Bundled releases use an internal PostgreSQL service and named volume by default; an explicit external database mode runs the same image against an operator-supplied DATABASE_URL. Native remains opt-in and the legacy export path remains the default.

**Tech Stack:** Node.js 22+, TypeScript, Fastify, React, PostgreSQL, pg, Zod, Node crypto.scrypt, Nodemailer SMTP, Mailpit, Vitest, Testing Library, Playwright, Docker Compose, existing PolarUI node:test release tests.

**Design SSoT:** docs/superpowers/specs/2026-07-15-native-workflow-web-identity-persistence-design.md

---

## Ordinary SubAgent collaboration protocol

1. The Main Agent owns dependency order, task boundaries, integration decisions, diff review, exact staging, commits, and final acceptance.
2. Tasks 1–10 are delegated one at a time to an ordinary task-level SubAgent.
3. Each assignment includes the complete task text, allowed files, repository context, and exact acceptance commands.
4. A SubAgent modifies only declared task files, follows the RED/GREEN sequence, reports changed files and command output, and does not run git add or git commit.
5. The Main Agent reviews every diff and reruns the task acceptance commands before staging exact files and committing.
6. A failed review returns only the bounded defect to the same SubAgent.
7. Tasks execute sequentially because package-lock.json, application composition, Docker files, and export scripts are shared.
8. Task 11 is Main-Agent-only and is the release gate.
9. Existing unrelated repository changes must not be staged or reformatted.
10. Real PostgreSQL, Mailpit, Docker, and Playwright checks are mandatory; mocks cannot replace them.

## Scope boundary

Phase 2 includes identity and PostgreSQL persistence only.

Do not implement password reset, invitations, 2FA, social login, a Web administrator console, Context/Route/Stage/Thread/Checkpoint persistence, workflow execution, messages, attachments, SSE, artifacts, LibreChat import, or native-default cutover.

## File map

### Template root and database

- Modify: PolarUI/templates/native-web/package.json
- Modify: PolarUI/templates/native-web/package-lock.json
- Modify: PolarUI/templates/native-web/.env.example
- Modify: PolarUI/templates/native-web/README.md
- Modify: PolarUI/templates/native-web/Dockerfile
- Modify: PolarUI/templates/native-web/.dockerignore
- Modify: PolarUI/templates/native-web/compose.yml
- Create: PolarUI/templates/native-web/compose.external-db.yml
- Create: PolarUI/templates/native-web/db/migrations/0001_identity.sql

### API configuration, database, and security

- Modify: PolarUI/templates/native-web/apps/api/package.json
- Modify: PolarUI/templates/native-web/apps/api/src/app.ts
- Modify: PolarUI/templates/native-web/apps/api/src/server.ts
- Create: PolarUI/templates/native-web/apps/api/src/config.ts
- Create: PolarUI/templates/native-web/apps/api/src/db/pool.ts
- Create: PolarUI/templates/native-web/apps/api/src/db/migrate.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/identifiers.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/password.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/tokens.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/types.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/repository.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/mailer.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/service.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/session.ts
- Create: PolarUI/templates/native-web/apps/api/src/routes/auth.ts
- Create: PolarUI/templates/native-web/apps/api/src/scripts/create-user.ts

### API tests

- Create: PolarUI/templates/native-web/apps/api/tests/config.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/identifiers.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/password.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/tokens.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/migrate.integration.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/auth-repository.integration.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/auth-service.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/auth-routes.integration.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/create-user.integration.test.ts
- Modify: PolarUI/templates/native-web/apps/api/tests/app.test.ts

### Web authentication UI

- Modify: PolarUI/templates/native-web/apps/web/src/main.tsx
- Modify: PolarUI/templates/native-web/apps/web/src/App.tsx
- Modify: PolarUI/templates/native-web/apps/web/src/App.test.tsx
- Modify: PolarUI/templates/native-web/apps/web/src/styles.css
- Create: PolarUI/templates/native-web/apps/web/src/auth/api.ts
- Create: PolarUI/templates/native-web/apps/web/src/auth/storage.ts
- Create: PolarUI/templates/native-web/apps/web/src/auth/AuthGate.tsx
- Create: PolarUI/templates/native-web/apps/web/src/auth/LoginPage.tsx
- Create: PolarUI/templates/native-web/apps/web/src/auth/RegisterPage.tsx
- Create: PolarUI/templates/native-web/apps/web/src/auth/VerifyEmailPage.tsx
- Create: PolarUI/templates/native-web/apps/web/src/auth/auth.test.tsx

### Export, deployment, verification, and QA

- Modify: PolarUI/scripts/verify-release.mjs
- Modify: PolarUI/scripts/verify-release.test.mjs
- Modify: PolarUI/scripts/compile-site-config.mjs
- Modify: PolarUI/scripts/compile-site-config.test.mjs
- Modify: PolarUI/scripts/deploy-web-release.mjs
- Modify: PolarUI/scripts/export-release.test.mjs
- Create: PolarUI/scripts/native-identity-packaging.test.mjs
- Create: PolarUI/scripts/qa-native-identity-release.mjs
- Modify: PolarUI/package.json
- Modify: PolarUI/docs/WEB_EXPORT.md

## Task 1: Add validated identity configuration and direct dependencies

**Files:**

- Modify: PolarUI/templates/native-web/apps/api/package.json
- Modify: PolarUI/templates/native-web/package.json
- Modify: PolarUI/templates/native-web/package-lock.json
- Create: PolarUI/templates/native-web/apps/api/src/config.ts
- Create: PolarUI/templates/native-web/apps/api/tests/config.test.ts
- Modify: PolarUI/templates/native-web/.env.example

- [ ] **Step 1: Write failing configuration tests**

Create tests/config.test.ts with tests that call loadConfig using explicit environment objects:

    import { describe, expect, it } from 'vitest';
    import { loadConfig } from '../src/config.js';

    const valid = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://polar:polar@127.0.0.1:5432/polar',
      AUTH_PEPPER: 'test-pepper-with-at-least-32-characters',
      PUBLIC_APP_ORIGIN: 'http://127.0.0.1:3920',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_FROM: 'Polar <no-reply@example.test>',
      COOKIE_SECURE: 'false',
    };

    describe('loadConfig', () => {
      it('loads localhost test configuration', () => {
        const config = loadConfig(valid);
        expect(config.cookie.secure).toBe(false);
        expect(config.sessionTtlSeconds).toBe(30 * 24 * 60 * 60);
        expect(config.verificationTtlSeconds).toBe(10 * 60);
      });

      it('requires HTTPS and secure cookies in production', () => {
        expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/https/i);
        expect(() => loadConfig({
          ...valid,
          NODE_ENV: 'production',
          PUBLIC_APP_ORIGIN: 'https://workflow.example.com',
          COOKIE_SECURE: 'false',
        })).toThrow(/secure/i);
      });

      it('rejects missing database and short pepper values', () => {
        expect(() => loadConfig({ ...valid, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
        expect(() => loadConfig({ ...valid, AUTH_PEPPER: 'short' })).toThrow(/AUTH_PEPPER/);
      });
    });

- [ ] **Step 2: Run the test and verify RED**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/config.test.ts

Expected: FAIL because src/config.ts does not exist.

- [ ] **Step 3: Add dependencies and configuration implementation**

Declare direct API dependencies:

- @fastify/cookie
- @fastify/rate-limit
- nodemailer
- pg
- zod

Declare direct API development types:

- @types/nodemailer
- @types/pg

Add integration-test and user:create scripts to the API package. Add test:identity and qa:identity scripts to the template root.

Implement loadConfig with a strict Zod environment schema and return a typed object containing databaseUrl, authPepper, publicAppOrigin, SMTP settings, cookie settings, session TTL, verification TTL, and rate limits.

Default rate limits are:

- registration: five attempts per IP per 15 minutes;
- login: ten attempts per IP per 15 minutes;
- verification: ten attempts per IP per 15 minutes in addition to the five-attempt database challenge limit;
- resend: ten requests per IP per hour in addition to the per-user 60-second and five-per-hour service limits.

Production invariants:

- PUBLIC_APP_ORIGIN uses https.
- cookie secure is true.
- AUTH_PEPPER length is at least 32.
- DATABASE_URL and SMTP sender configuration are nonempty.

Local and test environments may use http only when COOKIE_SECURE=false is explicit.

Regenerate package-lock.json using npm install from the template root.

- [ ] **Step 4: Document environment placeholders**

Update .env.example with placeholders only:

    PORT=3920
    NODE_ENV=development
    DATABASE_URL=postgresql://polar:change-me@postgres:5432/polar
    AUTH_PEPPER=replace-with-at-least-32-random-characters
    PUBLIC_APP_ORIGIN=http://127.0.0.1:3920
    COOKIE_SECURE=false
    SMTP_HOST=mailpit
    SMTP_PORT=1025
    SMTP_FROM="Polar Workflow <no-reply@example.test>"
    SMTP_SECURE=false
    SMTP_USERNAME=
    SMTP_PASSWORD=

No value may be usable as a production credential.

- [ ] **Step 5: Run GREEN verification**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/config.test.ts
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build --workspace @polar/native-web-api

Expected: configuration tests PASS and TypeScript build exits 0.

- [ ] **Step 6: Main Agent checkpoint**

Main Agent reviews the lockfile and exact dependency changes, reruns Step 5, stages only Task 1 files, and commits:

    git commit -m "feat(polarui): configure native identity services"

## Task 2: Add PostgreSQL identity migration and migration runner

**Files:**

- Create: PolarUI/templates/native-web/db/migrations/0001_identity.sql
- Create: PolarUI/templates/native-web/apps/api/src/db/pool.ts
- Create: PolarUI/templates/native-web/apps/api/src/db/migrate.ts
- Create: PolarUI/templates/native-web/apps/api/tests/migrate.integration.test.ts

- [ ] **Step 1: Write the failing real-PostgreSQL migration test**

The integration test reads TEST_DATABASE_URL, skips only when the variable is absent, drops the public schema, calls runMigrations twice, and asserts:

- schema_migrations contains 0001_identity once;
- users, email_verifications, and auth_sessions exist;
- the stored checksum is nonempty;
- two concurrent runMigrations calls both resolve and still record one row.

The test must use pg directly to query information_schema and must close every pool.

- [ ] **Step 2: Start the test database and verify RED**

Run:

    docker rm -f polar-native-phase2-pg >/dev/null 2>&1 || true
    docker run -d --name polar-native-phase2-pg -e POSTGRES_PASSWORD=polar -e POSTGRES_USER=polar -e POSTGRES_DB=polar -p 55432:5432 postgres:16-alpine
    cd ~/Polarisor/PolarUI/templates/native-web
    TEST_DATABASE_URL=postgresql://polar:polar@127.0.0.1:55432/polar PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/migrate.integration.test.ts

Expected: FAIL because the migration runner does not exist.

- [ ] **Step 3: Create the migration SQL**

0001_identity.sql creates:

- schema_migrations;
- users with normalized unique indexes and status and created_via check constraints;
- email_verifications with timestamps, attempt_count nonnegative, foreign key cascade, and a partial unique index for one active challenge;
- auth_sessions with unique token_digest, expiry and revocation timestamps, user agent, IP prefix, and indexes by user and expiry.

The application supplies UUID values using Node crypto.randomUUID(). The migration must not require PostgreSQL extensions so external managed databases do not need extension-creation privileges.

- [ ] **Step 4: Implement pool and migration modules**

pool.ts exports:

    export function createPool(databaseUrl: string): Pool
    export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T>

migrate.ts:

- discovers numbered .sql files under the template db/migrations directory;
- computes SHA-256 checksums;
- acquires pg_advisory_lock with a fixed signed bigint;
- creates schema_migrations before reading applied versions;
- rejects checksum mismatch;
- applies each file and inserts its version in one transaction;
- always releases the advisory lock.

The module accepts an explicit migrationsDir so tests and the production server do not depend on the current working directory.

- [ ] **Step 5: Run GREEN integration and build**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    TEST_DATABASE_URL=postgresql://polar:polar@127.0.0.1:55432/polar PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/migrate.integration.test.ts
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build --workspace @polar/native-web-api

Expected: migration tests PASS, including concurrent execution, and the build exits 0.

- [ ] **Step 6: Main Agent checkpoint**

Main Agent inspects SQL constraints, verifies the real database container result, stages only Task 2 files, and commits:

    git commit -m "feat(polarui): add native identity migrations"

## Task 3: Implement identity normalization and cryptographic primitives

**Files:**

- Create: PolarUI/templates/native-web/apps/api/src/auth/identifiers.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/password.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/tokens.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/types.ts
- Create: PolarUI/templates/native-web/apps/api/tests/identifiers.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/password.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/tokens.test.ts

- [ ] **Step 1: Write failing primitive tests**

Tests must prove:

- email normalization trims, applies NFKC, and lowercases;
- username normalization preserves display text but compares NFKC lowercase;
- usernames accept Unicode letters and numbers plus underscore and hyphen at 3–32 characters;
- passwords accept 10–128 characters and reject shorter or longer input;
- password hashes use a versioned scrypt string and verify correctly;
- an incorrect password returns false;
- verification codes are exactly six numeric digits;
- HMAC digests compare without exposing the code;
- session tokens decode to at least 32 random bytes and digest deterministically;
- raw session tokens and verification codes are not equal to stored digests.

- [ ] **Step 2: Run tests and verify RED**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/identifiers.test.ts tests/password.test.ts tests/tokens.test.ts

Expected: FAIL because the auth primitive modules do not exist.

- [ ] **Step 3: Implement identifiers and shared types**

identifiers.ts exports parseEmail, parseUsername, normalizeEmail, and normalizeUsername. Validation returns stable validation errors rather than raw Zod internals.

types.ts defines:

    export type UserStatus = 'active' | 'disabled';
    export type UserCreatedVia = 'registration' | 'admin_cli';
    export interface PublicUser {
      id: string;
      email: string;
      username: string;
    }

- [ ] **Step 4: Implement password and token primitives**

password.ts uses promisified crypto.scrypt, a 16-byte random salt, a 64-byte derived key, and a versioned format:

    scrypt$v1$N$r$p$saltBase64$hashBase64

verifyPassword validates the encoded format, derives the same-length key, and uses timingSafeEqual. Invalid encoded values return false rather than throwing to route handlers.

tokens.ts exports:

- generateVerificationCode using randomInt(0, 1_000_000) and padStart(6, '0');
- digestVerificationCode using HMAC-SHA-256 with AUTH_PEPPER and user ID plus code;
- compareVerificationCodeDigest using timingSafeEqual;
- generateSessionToken using randomBytes(32).toString('base64url');
- digestSessionToken using SHA-256.

- [ ] **Step 5: Run GREEN tests and build**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/identifiers.test.ts tests/password.test.ts tests/tokens.test.ts
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build --workspace @polar/native-web-api

Expected: all primitive tests PASS and the API builds.

- [ ] **Step 6: Main Agent checkpoint**

Main Agent reviews cryptographic formats and constant-time comparisons, stages only Task 3 files, and commits:

    git commit -m "feat(polarui): add native auth primitives"

## Task 4: Add identity repositories and database invariants

**Files:**

- Create: PolarUI/templates/native-web/apps/api/src/auth/repository.ts
- Create: PolarUI/templates/native-web/apps/api/tests/auth-repository.integration.test.ts

- [ ] **Step 1: Write failing repository integration tests**

Against the real Task 2 database, cover:

- createUser stores normalized identifiers and a scrypt password hash;
- duplicate normalized email and username return typed conflict results;
- findUserByLoginIdentifier matches email and username case-insensitively;
- createVerification invalidates the previous active challenge;
- consumeVerification succeeds once and fails after consumption;
- failed verification attempts increment atomically and stop at five;
- createSession stores only the digest;
- findSessionUser rejects expired, revoked, and disabled-user sessions;
- revokeSession is idempotent;
- touchSession updates last_seen_at only when the configured interval elapsed.

- [ ] **Step 2: Run and verify RED**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    TEST_DATABASE_URL=postgresql://polar:polar@127.0.0.1:55432/polar PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/auth-repository.integration.test.ts

Expected: FAIL because repository.ts does not exist.

- [ ] **Step 3: Implement parameterized repository operations**

repository.ts exposes focused interfaces and createAuthRepository(pool). All SQL uses parameters. PostgreSQL unique constraint names are mapped to EMAIL_TAKEN and USERNAME_TAKEN without returning SQL messages.

Mutating verification operations use SELECT FOR UPDATE inside transactions. Session lookup joins users so disabled status invalidates the request immediately.

Repository return values use domain result unions instead of throwing for expected conflicts, expiration, attempts exhausted, or missing rows. Unexpected database failures still throw and are mapped at the service boundary.

- [ ] **Step 4: Run GREEN integration and build**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    TEST_DATABASE_URL=postgresql://polar:polar@127.0.0.1:55432/polar PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/auth-repository.integration.test.ts
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build --workspace @polar/native-web-api

Expected: repository integration tests PASS and TypeScript build exits 0.

- [ ] **Step 5: Main Agent checkpoint**

Main Agent reviews every SQL query, transaction boundary, and constraint mapping, stages Task 4 files, and commits:

    git commit -m "feat(polarui): persist native identity records"

## Task 5: Implement SMTP verification and identity service orchestration

**Files:**

- Create: PolarUI/templates/native-web/apps/api/src/auth/mailer.ts
- Create: PolarUI/templates/native-web/apps/api/src/auth/service.ts
- Create: PolarUI/templates/native-web/apps/api/tests/auth-service.test.ts

- [ ] **Step 1: Write failing service tests with fakes**

Use in-memory fake repositories and a recording fake mailer to prove:

- register validates input, hashes the password, creates an unverified user, creates a 10-minute challenge, and sends one message;
- SMTP failure preserves the created user and returns MAIL_DELIVERY_FAILED;
- resend returns a generic accepted result for missing or verified users;
- resend invalidates the previous challenge and enforces 60 seconds and five per hour;
- verifyEmail accepts the correct code once;
- wrong codes increment attempts and five failures exhaust the challenge;
- login accepts email or username only after verification;
- all missing, wrong-password, unverified, and disabled cases return INVALID_CREDENTIALS;
- login creates a 30-day session token and stores only its digest;
- logout revokes the digest.

- [ ] **Step 2: Run and verify RED**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/auth-service.test.ts

Expected: FAIL because mailer.ts and service.ts do not exist.

- [ ] **Step 3: Implement the mailer**

mailer.ts defines:

    export interface VerificationMailer {
      sendVerification(input: {
        email: string;
        productName: string;
        code: string;
        expiresAt: Date;
      }): Promise<void>;
    }

createSmtpVerificationMailer builds one SMTP transporter from validated config. The subject names the product, and the text and HTML bodies include the code and ten-minute expiry. The transporter logger is disabled. Thrown SMTP errors are converted to a sanitized MailDeliveryError.

- [ ] **Step 4: Implement the identity service**

createAuthService receives repository, mailer, pepper, product name, clock, and token generators. It exposes register, resendVerification, verifyEmail, login, logout, and getSessionUser.

The service contains no Fastify objects. It returns typed success or domain error values. For missing login identifiers it verifies the submitted password against a fixed valid dummy scrypt hash before returning INVALID_CREDENTIALS.

- [ ] **Step 5: Run GREEN tests and build**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/auth-service.test.ts
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build --workspace @polar/native-web-api

Expected: all identity service tests PASS and the API builds.

- [ ] **Step 6: Main Agent checkpoint**

Main Agent verifies no code or password enters logs or returned errors, stages Task 5 files, and commits:

    git commit -m "feat(polarui): orchestrate email identity flows"

## Task 6: Add same-origin auth routes, sessions, readiness, and public bootstrap

**Files:**

- Create: PolarUI/templates/native-web/apps/api/src/auth/session.ts
- Create: PolarUI/templates/native-web/apps/api/src/routes/auth.ts
- Modify: PolarUI/templates/native-web/apps/api/src/app.ts
- Modify: PolarUI/templates/native-web/apps/api/src/server.ts
- Modify: PolarUI/templates/native-web/apps/api/tests/app.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/auth-routes.integration.test.ts

- [ ] **Step 1: Write failing route integration tests**

Build the Fastify app with a real migrated PostgreSQL pool and fake mailer. Tests cover:

- POST /api/auth/register returns 201 and never returns the code;
- POST /api/auth/verify-email consumes a known test code;
- POST /api/auth/verification/resend always returns 202;
- POST /api/auth/login sets polar_session with HttpOnly, SameSite=Lax, Path=/, and configured Secure;
- GET /api/auth/session returns only id, email, and username;
- POST /api/auth/logout revokes and clears the cookie;
- missing or foreign Origin on state-changing routes returns 403;
- login rate limiting returns 429 without exposing credentials;
- GET /healthz works without a database query;
- GET /readyz reflects database readiness;
- /api/bootstrap omits workflow.endpoint.

- [ ] **Step 2: Run and verify RED**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    TEST_DATABASE_URL=postgresql://polar:polar@127.0.0.1:55432/polar PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/app.test.ts tests/auth-routes.integration.test.ts

Expected: FAIL because routes and session helpers do not exist.

- [ ] **Step 3: Implement cookie and Origin helpers**

session.ts parses the configured cookie, digests the token before service lookup, emits cookie attributes from validated config, clears cookies safely, and validates the exact scheme, host, and port of Origin against PUBLIC_APP_ORIGIN.

Requests without Origin are accepted only for GET, HEAD, OPTIONS, or the trusted CLI path that does not use HTTP.

- [ ] **Step 4: Implement auth routes and app composition**

routes/auth.ts uses Zod request schemas and maps domain errors to stable HTTP responses. Register route groups with @fastify/rate-limit using separate limits.

Refactor buildApp to accept explicit dependencies:

    buildApp({
      manifest,
      staticRoot,
      config,
      authService,
      readiness,
    })

Public bootstrap returns a projection that omits workflow.endpoint. server.ts loads config, creates the pool, runs migrations, creates repository, mailer, and service, then starts Fastify. Shutdown closes Fastify, SMTP transport, and PostgreSQL pool.

- [ ] **Step 5: Run GREEN integration and full API tests**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    TEST_DATABASE_URL=postgresql://polar:polar@127.0.0.1:55432/polar PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build --workspace @polar/native-web-api

Expected: all API tests PASS and the API builds.

- [ ] **Step 6: Main Agent checkpoint**

Main Agent checks cookies, Origin behavior, rate-limit response safety, bootstrap privacy, and shutdown behavior, stages Task 6 files, and commits:

    git commit -m "feat(polarui): expose native authentication API"

## Task 7: Add trusted administrator account CLI

**Files:**

- Modify: PolarUI/templates/native-web/apps/api/package.json
- Modify: PolarUI/templates/native-web/apps/api/src/auth/service.ts
- Create: PolarUI/templates/native-web/apps/api/src/scripts/create-user.ts
- Modify: PolarUI/templates/native-web/apps/api/tests/auth-service.test.ts
- Create: PolarUI/templates/native-web/apps/api/tests/create-user.integration.test.ts

- [ ] **Step 1: Write the failing CLI integration test**

The test calls exported runCreateUser with arguments and a real pool, then verifies:

- --verified is required;
- valid input creates active, verified, admin_cli user data;
- the stored password is a scrypt hash;
- duplicate email or username exits with a stable nonzero code;
- output names the created username but never prints the password or password hash.

- [ ] **Step 2: Run and verify RED**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    TEST_DATABASE_URL=postgresql://polar:polar@127.0.0.1:55432/polar PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/create-user.integration.test.ts

Expected: FAIL because create-user.ts does not exist.

- [ ] **Step 3: Implement the CLI**

First extend the shared service with createVerifiedAdminUser and add service tests proving that it validates identifier and password rules, hashes the password, sets email_verified_at, and writes created_via=admin_cli.

The CLI parses:

- --email
- --username
- --password
- mandatory --verified

It loads the same config, runs migrations, creates the same repository and service dependencies, and calls a shared createVerifiedAdminUser service operation. It closes the pool in finally and returns exit codes rather than calling process.exit inside testable logic.

Add:

    "user:create": "tsx src/scripts/create-user.ts"

to the API package and a root workspace forwarding script.

- [ ] **Step 4: Run GREEN CLI integration**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    TEST_DATABASE_URL=postgresql://polar:polar@127.0.0.1:55432/polar PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-api -- --run tests/create-user.integration.test.ts
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build --workspace @polar/native-web-api

Expected: CLI integration tests PASS and the API builds.

- [ ] **Step 5: Main Agent checkpoint**

Main Agent verifies the bypass is explicit and no credential output is logged, stages Task 7 files, and commits:

    git commit -m "feat(polarui): add trusted native user CLI"

## Task 8: Build the authenticated React flow and draft restoration

**Files:**

- Create: PolarUI/templates/native-web/apps/web/src/auth/api.ts
- Create: PolarUI/templates/native-web/apps/web/src/auth/storage.ts
- Create: PolarUI/templates/native-web/apps/web/src/auth/AuthGate.tsx
- Create: PolarUI/templates/native-web/apps/web/src/auth/LoginPage.tsx
- Create: PolarUI/templates/native-web/apps/web/src/auth/RegisterPage.tsx
- Create: PolarUI/templates/native-web/apps/web/src/auth/VerifyEmailPage.tsx
- Create: PolarUI/templates/native-web/apps/web/src/auth/auth.test.tsx
- Modify: PolarUI/templates/native-web/apps/web/src/main.tsx
- Modify: PolarUI/templates/native-web/apps/web/src/App.tsx
- Modify: PolarUI/templates/native-web/apps/web/src/App.test.tsx
- Modify: PolarUI/templates/native-web/apps/web/src/styles.css

- [ ] **Step 1: Write failing Web tests**

Testing Library tests cover:

- unauthenticated bootstrap renders the login page;
- register submits email, username, and password, then navigates to verify-email with only masked or local display data;
- verify page accepts six digits and exposes resend countdown;
- login label states email or username;
- successful login returns to the original protected URL;
- AuthGate renders the existing workflow shell for a session user;
- 401 after session expiry shows login without deleting the locally stored draft;
- successful re-login restores the draft;
- API errors map stable codes to concise Chinese messages;
- password and code values are never stored in localStorage.

- [ ] **Step 2: Run and verify RED**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-web -- --run src/auth/auth.test.tsx src/App.test.tsx

Expected: FAIL because the auth components do not exist.

- [ ] **Step 3: Implement the API client and storage**

api.ts uses same-origin fetch with credentials: same-origin and JSON. It exposes getSession, register, verifyEmail, resendVerification, login, and logout. It parses stable error codes and never logs request bodies.

storage.ts stores:

- return path under a product-scoped key;
- draft text under a product- and pathname-scoped key.

It never stores passwords, verification codes, cookies, or session data.

- [ ] **Step 4: Implement pages and AuthGate**

Use semantic form labels, browser autocomplete attributes, visible focus styles, aria-live error regions, and disabled pending states.

Registration fields:

- email with autocomplete=email;
- username with autocomplete=username;
- password with autocomplete=new-password.

Login fields:

- identifier labelled 邮箱或用户名;
- password with autocomplete=current-password.

Verification uses one accessible six-digit input with inputMode=numeric and autocomplete=one-time-code.

AuthGate performs one session bootstrap, preserves the current location on 401, and renders the existing App only for authenticated users. Logout returns to login.

- [ ] **Step 5: Integrate styling without redesigning Phase 1**

Extend styles.css with compact auth cards, field states, validation feedback, responsive layout, and reduced-motion behavior. Preserve the warm paper, deep-green, and copper Phase 1 design language and all existing workspace behavior.

- [ ] **Step 6: Run GREEN Web tests and build**

Run:

    cd ~/Polarisor/PolarUI/templates/native-web
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test --workspace @polar/native-web-web
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build --workspace @polar/native-web-web

Expected: all Web tests PASS and the production Web build exits 0.

- [ ] **Step 7: Main Agent checkpoint**

Main Agent reviews auth state transitions, localStorage exclusions, accessibility, and responsive behavior, stages Task 8 files, and commits:

    git commit -m "feat(polarui): add native identity screens"

## Task 9: Package PostgreSQL and Mailpit deployment modes

**Files:**

- Modify: PolarUI/templates/native-web/Dockerfile
- Modify: PolarUI/templates/native-web/compose.yml
- Create: PolarUI/templates/native-web/compose.external-db.yml
- Modify: PolarUI/templates/native-web/README.md
- Modify: PolarUI/templates/native-web/.dockerignore
- Create: PolarUI/scripts/native-identity-packaging.test.mjs

- [ ] **Step 1: Write deployment assertions before implementation**

Create scripts/native-identity-packaging.test.mjs. The shell-independent node:test file reads the Docker and Compose files and asserts:

- bundled compose defines web and postgres;
- only web has ports;
- postgres has a named volume and health check;
- Mailpit is restricted to a qa or development profile;
- external compose defines only web and requires DATABASE_URL;
- Dockerfile copies db/migrations and contains the production CLI assets.

Run:

    cd ~/Polarisor/PolarUI
    ~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test scripts/native-identity-packaging.test.mjs

Expected: FAIL because the identity packaging topology is absent.

- [ ] **Step 2: Update the production image**

The Docker build copies db/migrations into both build context and runtime image. Runtime production dependencies include pg, SMTP, cookie, rate-limit, and Zod packages. The final image continues to expose only port 3920 and starts the API server.

- [ ] **Step 3: Implement bundled Compose**

compose.yml defines:

- web with the application image, internal DATABASE_URL, auth pepper, public origin, SMTP configuration, PostgreSQL health dependency, and only 3920 published;
- postgres:16-alpine with internal credentials supplied through environment or Docker secrets, no ports, a pg_isready health check, and a named volume;
- mailpit under a qa profile with internal SMTP and HTTP ports but no production host publishing by default.

Do not include a real production secret in the file.

- [ ] **Step 4: Implement external database Compose**

compose.external-db.yml defines only web. It requires DATABASE_URL, AUTH_PEPPER, PUBLIC_APP_ORIGIN, and SMTP settings from the operator environment and publishes one Web port.

- [ ] **Step 5: Document exact commands**

README documents:

- npm development with local PostgreSQL and Mailpit;
- bundled docker compose startup;
- external database startup;
- migrations on startup;
- administrator CLI invocation;
- environment secret generation;
- the absence of public PostgreSQL exposure.

- [ ] **Step 6: Run packaging tests and actual image build**

Run:

    cd ~/Polarisor/PolarUI
    ~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test scripts/native-identity-packaging.test.mjs
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run test:native-web
    docker build -t polar-native-identity-plan-check templates/native-web

Expected: focused packaging and native tests PASS and the actual production image builds.

- [ ] **Step 7: Main Agent checkpoint**

Main Agent inspects image contents, Compose ports, secret placeholders, and runtime dependencies, stages Task 9 files, and commits:

    git commit -m "feat(polarui): package native identity database"

## Task 10: Extend export, verification, deployment, and real identity QA

**Files:**

- Modify: PolarUI/scripts/verify-release.mjs
- Modify: PolarUI/scripts/verify-release.test.mjs
- Modify: PolarUI/scripts/compile-site-config.mjs
- Modify: PolarUI/scripts/compile-site-config.test.mjs
- Modify: PolarUI/scripts/deploy-web-release.mjs
- Modify: PolarUI/scripts/export-release.test.mjs
- Create: PolarUI/scripts/qa-native-identity-release.mjs
- Modify: PolarUI/package.json
- Modify: PolarUI/docs/WEB_EXPORT.md

- [ ] **Step 1: Write failing export and deployment tests**

Tests assert:

- native exports contain 0001_identity.sql, bundled and external Compose files, and identity environment placeholders;
- native verification rejects missing migrations, public PostgreSQL ports, embedded usable secrets, or missing auth configuration;
- compiled native site config declares identity persistence and bundled or external database mode without exposing credentials;
- native deployment defaults to bundled Compose mode;
- --database-mode external requires DATABASE_URL and starts only web;
- legacy default export and P2a behavior are unchanged.

Run the focused node:test files and confirm the new assertions fail.

- [ ] **Step 2: Implement release metadata and verification**

compile-site-config emits non-secret metadata:

    {
      "web": {
        "template_flavor": "native",
        "identity": {
          "provider": "native-postgresql",
          "email_verification": "six-digit-code",
          "login_identifiers": ["email", "username"]
        }
      }
    }

verify-release requires identity migrations and Compose files for native releases, scans for forbidden runtime dependencies and usable secrets, and rejects PostgreSQL host-port publication.

- [ ] **Step 3: Implement deployment modes**

deploy-web-release accepts --database-mode bundled or external.

Bundled mode uses Docker Compose, waits for /readyz, and preserves the named PostgreSQL volume across Web image updates.

External mode requires DATABASE_URL, starts one Web container, passes secrets only through environment or an env file outside the release tree, and waits for /readyz.

Failure cleanup removes newly started containers without deleting an existing data volume.

- [ ] **Step 4: Build the real identity QA script**

qa-native-identity-release.mjs must:

1. export a fresh native release fixture;
2. allocate collision-free Web, PostgreSQL, and Mailpit test resources;
3. start PostgreSQL and Mailpit without exposing PostgreSQL publicly;
4. build and start the exported production image;
5. wait for /readyz;
6. launch Playwright at 1440x900;
7. register a unique email and username;
8. prove login is rejected before verification;
9. query Mailpit HTTP API and extract the six-digit code;
10. verify the email;
11. log in with email and refresh successfully;
12. log out and log in with username;
13. save a draft on a protected URL;
14. revoke the session in PostgreSQL;
15. log in again and verify URL and draft restoration;
16. restart the Web container and verify a valid session survives;
17. create a second account through the administrator CLI and log in;
18. repeat a readiness smoke test in external DATABASE_URL mode;
19. repeat critical page assertions at 390x844;
20. inspect the release and running containers for LibreChat and MongoDB absence;
21. clean containers, networks, images, and temporary files in finally while preserving failure artifacts.

The script prints exactly:

    [QA PASS] native identity production release

only after every assertion passes.

- [ ] **Step 5: Wire scripts and documentation**

Add:

    "qa:native-identity": "node scripts/qa-native-identity-release.mjs"

Document native registration, Mailpit QA, bundled and external database deployment, administrator CLI use, and the fact that native remains opt-in.

- [ ] **Step 6: Run focused release tests**

Run:

    cd ~/Polarisor/PolarUI
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run test:native-web
    ~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test scripts/compile-site-config.test.mjs scripts/export-release.test.mjs scripts/verify-release.test.mjs

Expected: all focused tests PASS.

- [ ] **Step 7: Run actual production identity QA**

Run:

    cd ~/Polarisor/PolarUI
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run qa:native-identity

Expected final line:

    [QA PASS] native identity production release

- [ ] **Step 8: Main Agent checkpoint**

Main Agent reviews container cleanup, secret handling, persistent-volume behavior, browser evidence, and legacy boundaries, stages only Task 10 files, and commits:

    git commit -m "test(polarui): gate native identity releases"

## Task 11: Phase 2 final verification and handoff

**Execution owner:** Main Agent only. Do not delegate.

**Files:**

- Verify only; modify files only when a command exposes a defect.

- [ ] **Step 1: Static and repository checks**

Run:

    cd ~/Polarisor
    git diff --check
    ~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check PolarUI/scripts/deploy-web-release.mjs
    ~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check PolarUI/scripts/qa-native-identity-release.mjs
    git status --short -- PolarUI

Expected: checks exit 0 and no uncommitted Phase 2 file remains.

- [ ] **Step 2: Template unit and integration suite**

Start a fresh PostgreSQL test container, then run:

    docker rm -f polar-native-phase2-final-pg >/dev/null 2>&1 || true
    docker run -d --name polar-native-phase2-final-pg -e POSTGRES_PASSWORD=polar -e POSTGRES_USER=polar -e POSTGRES_DB=polar -p 55432:5432 postgres:16-alpine
    until docker exec polar-native-phase2-final-pg pg_isready -U polar -d polar >/dev/null 2>&1; do sleep 1; done
    cd ~/Polarisor/PolarUI/templates/native-web
    TEST_DATABASE_URL=postgresql://polar:polar@127.0.0.1:55432/polar PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build
    docker rm -f polar-native-phase2-final-pg

Expected: all template tests PASS and the build exits 0.

- [ ] **Step 3: Exporter and compatibility suite**

Run:

    cd ~/Polarisor/PolarUI
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run test:native-web
    ~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test scripts/compile-site-config.test.mjs scripts/export-release.test.mjs scripts/verify-release.test.mjs
    ~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test --test-name-pattern='legacy flavor|AC-R01|P2a' scripts/native-template.test.mjs scripts/export-release.test.mjs

Expected: native and selected legacy compatibility tests PASS with zero failures.

- [ ] **Step 4: Production identity gate**

Run:

    cd ~/Polarisor/PolarUI
    PATH=~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run qa:native-identity

Expected:

    [QA PASS] native identity production release

- [ ] **Step 5: Confirm acceptance criteria**

The Main Agent records evidence for:

- real migration and concurrent startup safety;
- public registration and Mailpit verification;
- unverified login rejection;
- email and username login;
- logout and disabled-session rejection;
- administrator CLI creation;
- Web restart session persistence;
- bundled and external database modes;
- protected return URL and local draft restoration;
- desktop and 390-pixel browser QA;
- no public PostgreSQL port;
- no LibreChat or MongoDB dependency;
- native opt-in and legacy default preservation.

- [ ] **Step 6: Record follow-on boundary**

Phase 3 begins with Context, Route, Stage, Thread, and Checkpoint persistence and APIs. Do not add workflow execution or artifacts until that domain plan is independently approved.
