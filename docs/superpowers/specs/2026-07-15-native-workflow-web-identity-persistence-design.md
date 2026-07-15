# Native Workflow Web Identity and PostgreSQL Persistence Design

**Status:** Approved for implementation on 2026-07-15.

**Phase:** Native Workflow Web Template Phase 2.

**Scope owner:** `PolarUI/templates/native-web` and the native export, verification, deployment, and QA pipeline.

## 1. Goal

Phase 2 turns the Phase 1 native shell into an independently deployable authenticated product backed by real PostgreSQL persistence.

The release must support:

- public registration with email, username, and password;
- six-digit email verification;
- login by either email or username;
- logout and persistent server-side sessions;
- trusted administrator account creation from a CLI;
- a bundled PostgreSQL deployment by default and an external `DATABASE_URL` mode;
- real PostgreSQL, Mailpit, production-container, and browser acceptance evidence.

The identity system is owned by the native template. It must not create `@polar.local` identities, issue or consume LibreChat JWTs, or depend on LibreChat or MongoDB at runtime.

## 2. Non-goals

Phase 2 does not implement:

- password reset or forgotten-password flows;
- invitations, social login, passkeys, or two-factor authentication;
- a visual administrator console;
- Context, Route, Stage state, Thread, Checkpoint, messages, or attachments;
- Workflow Bridge execution, SSE, command idempotency, or route forking;
- LibreChat history import;
- switching the native template to the default export flavor.

Those capabilities require later independently testable phases.

## 3. Product rules

1. A public user registers with all three fields: email, username, and password.
2. Public users cannot log in until their email address has been verified.
3. Email verification uses a six-digit numeric code entered in the Web UI.
4. Login accepts either the normalized email address or normalized username in one identifier field.
5. A trusted administrator CLI can create a verified user without completing the email challenge.
6. A valid, unique email remains mandatory for administrator-created users.
7. The browser authenticates with a same-origin HttpOnly session cookie.
8. Production cookies are always Secure. Localhost development can explicitly disable Secure cookies.
9. Losing a session must not erase a local unsent draft or the original product URL. After login, the application returns to that URL.
10. Native remains opt-in throughout Phase 2; the legacy export flavor remains the default.

## 4. Architecture and service boundary

`polar-web` remains the only public service. The React application and Fastify API are served from the same origin.

```text
Browser
  -> same-origin HTTPS and HttpOnly cookie
polar-web (React + Fastify)
  -> identity services
  -> PostgreSQL
  -> SMTP adapter
SMTP adapter
  -> Mailpit in development and QA
  -> configured SMTP service in production

Trusted operator
  -> create-user CLI
  -> the same identity service and PostgreSQL database
```

PostgreSQL, Mailpit, and SMTP credentials are never exposed to the browser. PostgreSQL stays on an internal Docker network in bundled mode and is not assigned a public host port by the production deployment.

The existing `/api/bootstrap` response is split into a public browser projection and server-private manifest data. The browser projection may include product identity, labels, ordered Stage presentation, and registered component keys. It must not expose the internal workflow endpoint or future workflow credentials.

## 5. Technology choices

- PostgreSQL access: `pg` with explicit parameterized SQL.
- Migrations: ordered SQL files and a small in-template migration runner.
- Password hashing: Node.js `crypto.scrypt` with a per-password random salt.
- Session model: opaque random bearer token in a cookie; SHA-256 token digest in PostgreSQL.
- Verification-code storage: HMAC-SHA-256 digest using a required `AUTH_PEPPER`.
- HTTP framework: the existing Fastify application.
- Mail delivery: a narrow SMTP mailer interface backed by Nodemailer-compatible SMTP transport.
- Validation: Zod schemas at HTTP, CLI, and configuration boundaries.

An ORM is deliberately excluded from Phase 2. Database access is isolated behind repository interfaces so a later move to an ORM does not change route or service contracts.

## 6. Database lifecycle

### 6.1 Migration execution

The template contains versioned migrations under `db/migrations/`. A `schema_migrations` table records the exact migration version and checksum.

At application startup:

1. connect using `DATABASE_URL`;
2. acquire a PostgreSQL advisory lock dedicated to native-template migrations;
3. create `schema_migrations` when absent;
4. compare the applied checksum with the checked-in migration checksum;
5. execute unapplied migrations in order, each within a transaction;
6. release the lock;
7. mark the application ready only after migration and a database query succeed.

A checksum mismatch or migration failure prevents readiness and terminates startup with a sanitized diagnostic. Concurrent application starts must serialize through the advisory lock and must not apply a migration twice.

### 6.2 Identifier representation

Primary keys use UUIDs generated by PostgreSQL or the application with cryptographically secure randomness.

Email and username retain both display and normalized values:

- `email` preserves the trimmed user input;
- `email_normalized` is Unicode NFKC normalized, trimmed, and lowercased;
- `username` preserves the accepted display form;
- `username_normalized` is Unicode NFKC normalized and lowercased.

The application validates normalization before insertion, while PostgreSQL unique indexes provide the final concurrency-safe uniqueness guarantee.

Usernames contain 3–32 Unicode letters or numbers plus `_` and `-`. Passwords contain 10–128 characters. Phase 2 does not impose arbitrary uppercase, number, or symbol composition rules.

## 7. Data model

### 7.1 `schema_migrations`

- `version text primary key`
- `checksum text not null`
- `applied_at timestamptz not null default now()`

### 7.2 `users`

- `id uuid primary key`
- `email text not null`
- `email_normalized text not null unique`
- `username text not null`
- `username_normalized text not null unique`
- `password_hash text not null`
- `email_verified_at timestamptz null`
- `status text not null` constrained to `active` or `disabled`
- `created_via text not null` constrained to `registration` or `admin_cli`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

No administrator role is introduced yet. Trust for account creation comes from access to the operator environment and database credentials, not from a browser session.

### 7.3 `email_verifications`

- `id uuid primary key`
- `user_id uuid not null references users(id) on delete cascade`
- `code_digest text not null`
- `attempt_count integer not null default 0`
- `sent_at timestamptz not null`
- `expires_at timestamptz not null`
- `consumed_at timestamptz null`
- `invalidated_at timestamptz null`
- `created_at timestamptz not null default now()`

Only one unconsumed verification may be active per user. Creating a replacement invalidates the previous record in the same transaction.

A code expires after 10 minutes, permits at most five failed attempts, and is single-use. Resending is unavailable for 60 seconds after the previous send and is capped at five sends per user per hour.

### 7.4 `auth_sessions`

- `id uuid primary key`
- `user_id uuid not null references users(id) on delete cascade`
- `token_digest text not null unique`
- `created_at timestamptz not null default now()`
- `last_seen_at timestamptz not null default now()`
- `expires_at timestamptz not null`
- `revoked_at timestamptz null`
- `user_agent text null`
- `ip_prefix text null`

Session lifetime is an absolute 30 days. `last_seen_at` is updated at a bounded interval rather than on every request. Logout revokes the current session. Disabled users are rejected even when an otherwise valid session exists.

The database stores only a SHA-256 digest of the high-entropy session token. The unhashed token exists only in the Set-Cookie header and browser cookie storage.

## 8. Identity services

Identity behavior is divided into focused modules:

- configuration parsing and security invariants;
- database pool and transaction handling;
- migrations;
- user repository;
- verification repository;
- session repository;
- password hashing and verification;
- email verification issuance and consumption;
- SMTP mail delivery;
- authentication orchestration;
- Fastify routes;
- administrator CLI.

Routes and the CLI call the same service layer. Neither route handlers nor the CLI write identity tables directly.

Registration commits the user and verification record before attempting SMTP delivery. If SMTP delivery fails, the account remains unverified and the API returns a retryable mail-delivery error. The user can recover through the resend endpoint.

## 9. HTTP API

All request and response bodies are validated. Errors use stable machine-readable codes and safe user-facing messages.

### 9.1 `POST /api/auth/register`

Input:

```json
{
  "email": "reader@example.com",
  "username": "reader",
  "password": "correct-horse-battery-staple"
}
```

Success returns `201` with `verification_required: true` and a masked email display value. Email or username conflicts return `409` with `EMAIL_TAKEN` or `USERNAME_TAKEN`. Database details are not exposed.

### 9.2 `POST /api/auth/verify-email`

Input contains email and the six-digit code. Success marks the email verified and consumes the challenge in one transaction. It does not create a login session. Expired, exhausted, consumed, or incorrect challenges return safe verification error codes.

### 9.3 `POST /api/auth/verification/resend`

Input contains the email address. The endpoint always returns `202` with a generic response, whether or not an eligible user exists. This prevents account enumeration. An eligible unverified user receives a replacement challenge subject to resend limits.

### 9.4 `POST /api/auth/login`

Input contains one `identifier` field and a password. The service searches the normalized identifier against email and username.

Unknown accounts, wrong passwords, unverified email addresses, and disabled accounts return the same `401 INVALID_CREDENTIALS` response. Successful login creates a session and emits the session cookie.

### 9.5 `POST /api/auth/logout`

The current session is revoked when present and the cookie is cleared. Repeated logout is safe.

### 9.6 `GET /api/auth/session`

An authenticated response contains only:

```json
{
  "user": {
    "id": "uuid",
    "email": "reader@example.com",
    "username": "reader"
  }
}
```

Missing, expired, revoked, or disabled sessions return `401`.

## 10. Cookie and request security

The default cookie name is `polar_session`.

Cookie attributes are:

- `HttpOnly` always;
- `SameSite=Lax` always;
- `Path=/`;
- `Secure=true` whenever `NODE_ENV=production`;
- explicit localhost-only override for automated and local HTTP development;
- `Max-Age` aligned with the 30-day absolute database expiry.

Every state-changing authentication request validates the `Origin` header against the configured public application origin. Production startup fails when the public origin is missing, is not HTTPS, or conflicts with cookie security.

Rate limits apply independently to registration, login, verification, and resend. Login errors remain generic. Password hashes are still computed for unknown identifiers using a fixed dummy hash to reduce timing differences.

Sensitive values are redacted from logs. Passwords, verification codes, SMTP credentials, cookies, and raw session tokens must never appear in application or QA output.

## 11. Mail delivery

The mailer accepts a narrow command containing recipient email, product name, six-digit code, and expiry time. Templates are owned by the native template and contain no workflow secrets.

Development and automated QA connect to Mailpit through SMTP. Browser QA retrieves the message through Mailpit's HTTP API and extracts the six-digit code. It never reads a personal mailbox.

Production accepts SMTP host, port, TLS mode, sender address, username, and password through environment variables. Credentials are not compiled into exported releases or checked into Git.

## 12. Administrator account creation

The template exposes a trusted operator command:

```bash
npm run user:create -- \
  --email qa@example.com \
  --username qa_user \
  --password 'temporary-password' \
  --verified
```

`--verified` is required to make bypassing the email challenge explicit. The command validates the same email, username, and password rules as public registration, hashes the password through the shared password service, writes `created_via=admin_cli`, and exits nonzero on conflicts or invalid configuration.

Phase 2 does not provide a Web administrator page or an administrator browser role.

## 13. Web application behavior

The React application adds three minimal pages that use the Phase 1 visual language:

- `/register` for email, username, and password;
- `/verify-email` for the six-digit code, resend countdown, and delivery feedback;
- `/login` for email-or-username and password.

The workspace is wrapped by an `AuthGate`. It requests `/api/auth/session` during bootstrap and renders the workspace only for an authenticated user.

When authentication expires:

1. the current URL is retained as the post-login return target;
2. draft input is retained in local storage under a product- and location-scoped key;
3. the login page replaces the protected content without discarding the return target;
4. successful login returns to the original URL;
5. the restored workspace reloads the draft.

Phase 2 stores only the local draft and return target. Server-side Context, Route, Stage, Thread, and message persistence starts in later phases.

## 14. Configuration

The API validates configuration before opening its public listener.

Required production values:

- `DATABASE_URL`
- `AUTH_PEPPER`
- `PUBLIC_APP_ORIGIN`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_FROM`

Conditionally required values:

- `SMTP_USERNAME` and `SMTP_PASSWORD` when the SMTP service requires authentication;
- TLS mode matching the selected SMTP service.

Optional values have secure defaults for cookie name, session lifetime, verification lifetime, and bounded rate limits. `.env.example` contains placeholders only and no usable secret.

## 15. Deployment modes

### 15.1 Bundled database mode

Bundled mode is the default release experience. Docker Compose starts:

- one public `polar-web` container;
- one internal PostgreSQL container;
- one named PostgreSQL data volume.

Only the Web port is published. PostgreSQL has a health check and no public host port. `polar-web` starts only after PostgreSQL is healthy, applies migrations, and then becomes ready.

Mailpit is available only through a development or QA profile and is not part of the production service set.

### 15.2 External database mode

External mode starts only `polar-web` and requires an operator-provided `DATABASE_URL`. The native deployment command exposes an explicit database-mode option so it does not silently start an unused bundled database.

Both modes run the same migrations and application image. The database schema is not compiled differently for managed PostgreSQL.

## 16. Health and error behavior

- `GET /healthz` reports process liveness without querying PostgreSQL.
- `GET /readyz` returns success only after configuration validation, migrations, and a database readiness query.
- Database unavailability returns safe `503` responses from identity endpoints while the static login application remains serveable when the process is already running.
- SMTP delivery failure returns a retryable error and does not delete the unverified account.
- Invalid verification output, token parsing, and configuration fail closed.
- User-facing responses never expose SQL, stack traces, secret values, or internal workflow configuration.

Stable error codes include:

- `EMAIL_TAKEN`
- `USERNAME_TAKEN`
- `INVALID_CREDENTIALS`
- `INVALID_VERIFICATION_CODE`
- `VERIFICATION_EXPIRED`
- `VERIFICATION_RATE_LIMITED`
- `MAIL_DELIVERY_FAILED`
- `AUTH_SERVICE_UNAVAILABLE`

## 17. Test strategy and release gates

### 17.1 Unit tests

Unit tests cover:

- email and username normalization;
- username and password validation;
- scrypt encoding and verification;
- verification HMAC digest and constant-time comparison;
- session token generation and digesting;
- cookie security decisions;
- public bootstrap projection;
- error-code mapping and secret redaction.

### 17.2 PostgreSQL integration tests

Tests run against a real PostgreSQL container and cover:

- empty-database migration;
- repeated migration execution;
- concurrent migration lock behavior;
- registration transaction and uniqueness conflicts;
- replacement verification invalidating the previous code;
- verification expiry, attempt exhaustion, and single use;
- login by email and username;
- generic login failure behavior;
- logout and session revocation;
- disabled-user session rejection;
- session survival across application restart;
- administrator CLI account creation.

### 17.3 Mailpit integration

The test environment sends a real SMTP message to Mailpit, retrieves it through the Mailpit API, extracts the six-digit code, and completes verification through the public HTTP API.

### 17.4 Production-container browser QA

Playwright visits the actual exported production port at desktop and 390-pixel widths and completes:

```text
register a new email and username
-> retrieve the six-digit code from Mailpit
-> verify the email
-> log in with email
-> refresh and retain the session
-> log out
-> log in with username
-> visit a protected workspace URL
-> expire or revoke the session
-> log in and return to the same URL with the local draft intact
```

The QA gate also verifies:

- administrator CLI creation and login;
- persistence through Web-container restart;
- external `DATABASE_URL` mode;
- no public PostgreSQL port in bundled production mode;
- no LibreChat or MongoDB runtime dependency;
- legacy export remains the default;
- native export remains opt-in;
- all Phase 1 desktop and mobile shell assertions continue to pass.

Source-only unit tests or a temporary development server cannot replace the production-container gate.

## 18. Export and verification changes

Native exports add migrations, identity configuration examples, the PostgreSQL-aware Compose definition, and the operator CLI. Release verification requires the identity migration, database configuration contract, and production container topology.

Secret scanning rejects exported usable credentials. The exporter may emit secret placeholders or generate deployment-local secrets outside the tracked release tree, but it must not embed a production password, `AUTH_PEPPER`, SMTP credential, or database credential in Git-tracked content.

Legacy exports and existing LibreChat compatibility behavior are unchanged during this phase.

## 19. Acceptance criteria

Phase 2 is complete only when all of the following are demonstrated with fresh automated evidence:

1. A clean PostgreSQL database migrates successfully and repeated startup is safe.
2. A user can register with email, username, and password.
3. Mailpit receives a six-digit code and the user can verify the email.
4. An unverified user cannot log in.
5. A verified user can log in by email or username.
6. Logout revokes the server-side session.
7. A Session survives a `polar-web` container restart and expires according to database state.
8. A disabled user cannot continue using an existing Session.
9. The trusted CLI creates a verified account that can log in.
10. Bundled and external PostgreSQL modes both pass smoke tests.
11. Only `polar-web` is publicly exposed in bundled production mode.
12. Protected navigation, return URL, and local draft restoration work in the real production container.
13. Desktop and 390-pixel browser journeys pass.
14. Native exports contain no LibreChat or MongoDB runtime dependency.
15. Legacy remains the default export flavor and native remains opt-in.

## 20. Follow-on order

After Phase 2, implementation proceeds in this order:

1. Context, Route, Stage, Thread, and Checkpoint domain persistence and APIs;
2. Workflow Bridge, SSE, command idempotency, and controlled adoption and fork actions;
3. artifact storage and fixed component-registry expansion;
4. LibreChat read-only import, native-default cutover, and full release migration gates.
