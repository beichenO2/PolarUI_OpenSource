# Polar Native Workflow Web Template

Tracked source for native Polar workflow web releases. This implementation is independent from the legacy chat runtime.

## npm development with local PostgreSQL and Mailpit

Start development-only PostgreSQL and Mailpit containers bound to the loopback interface:

```bash
docker run --name polar-native-postgres-dev --rm -d \
  -e POSTGRES_DB=polar -e POSTGRES_USER=polar -e POSTGRES_PASSWORD=polar-dev-only \
  -p 127.0.0.1:5432:5432 postgres:16-alpine
docker run --name polar-native-mailpit-dev --rm -d \
  -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 ghcr.io/axllent/mailpit:v1.27
```

Install, build the browser application, and start the API in watch mode:

```bash
npm install
npm run build
export DATABASE_URL='postgresql://polar:polar-dev-only@127.0.0.1:5432/polar'
export AUTH_PEPPER="$(openssl rand -hex 32)"
export PUBLIC_APP_ORIGIN='http://127.0.0.1:3920'
export COOKIE_SECURE=false
export SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_SECURE=false
export SMTP_FROM='Polar Workflow <no-reply@example.test>'
npm run dev:api
```

Open `http://127.0.0.1:3920`; Mailpit's development inbox is at `http://127.0.0.1:8025`. Rebuild the web workspace after browser-source changes with `npm run build -w @polar/native-web-web`.

## Persisted workflow hierarchy

After authentication, the native Web UI persists this release-owned hierarchy in PostgreSQL:

```text
User -> Context -> Route -> Stage -> Thread -> Checkpoint
```

Creating a Context atomically creates its main Route, manifest Stage projections, and immutable version-zero Checkpoint. Stage navigation is free and never advances workflow state. Threads remain scoped to one Route and Stage. “从此检查点创建新路线” clones the selected snapshot into a new Route while retaining the original Route.

Thread messages and workflow commands are also persisted. Command creation is deliberately separate from event observation so a browser disconnect never cancels workflow execution:

```text
GET  /api/contexts
POST /api/contexts
GET  /api/contexts/:contextId/workspace
GET  /api/routes/:routeId/workspace?stage=<stage-key>&checkpoint=<uuid>
POST /api/routes/:routeId/threads
PATCH /api/threads/:threadId
POST /api/contexts/:contextId/routes
GET  /api/threads/:threadId/messages
POST /api/threads/:threadId/commands
GET  /api/commands/:commandId/events
```

All endpoints derive ownership from the HttpOnly session. Mutation requests also require the configured same-origin `Origin` header.

`POST /api/threads/:threadId/commands` returns `202` with a stable command ID and event URL. The event URL is an authenticated SSE endpoint that persists and replays `command.accepted`, `workflow.started`, `assistant.delta`, `workspace.committed`, and the terminal `command.finished`. Reconnect with `Last-Event-ID`; heartbeat comments keep idle proxy connections open, while `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` prevent buffering.

The command UUID is the durable idempotency key and is also sent upstream as `Idempotency-Key`. Reusing it with identical input replays stored events without another workflow call; reusing it with different input is rejected. The server never automatically retries an upstream timeout because the legacy workflow protocol cannot guarantee that a timed-out request had no side effects.

Set `WORKFLOW_ENDPOINT_OVERRIDE` to the complete workflow `/run` URL when the manifest endpoint is not reachable from the deployment network, and optionally set the positive millisecond timeout `WORKFLOW_TIMEOUT_MS` (default `60000`). Both Compose modes forward these values to the Web container.

`GET /api/threads/:threadId/messages` returns persisted messages plus only the public ID and prompt for a pending human-input interrupt. Resume it with an authenticated `resume_interrupt` command containing that public interrupt ID and the user's reply. The private PolarFlow cursor stays in PostgreSQL, is never returned to the browser, and is restored upstream only by the server during that resume.

Phase 5 remains unstarted. It owns attachments, artifact/object storage, optional memory-proposal management, LibreChat archive import, and native-default cutover; none of those capabilities are part of the Phase 4 command runtime.

## Bundled Docker Compose

Generate operator secrets and start the application, internal PostgreSQL, and QA-only Mailpit:

```bash
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
export AUTH_PEPPER="$(openssl rand -hex 32)"
export PUBLIC_APP_ORIGIN='http://127.0.0.1:3920'
export NODE_ENV=development COOKIE_SECURE=false
export SMTP_HOST=mailpit SMTP_PORT=1025 SMTP_SECURE=false
export SMTP_FROM='Polar Workflow <no-reply@example.test>'
docker compose --profile qa up --build -d
curl -fsS http://127.0.0.1:3920/readyz
```

Omit `--profile qa` and supply production SMTP variables to run without Mailpit. The bundled topology publishes only Web port `3920`; PostgreSQL has no host port and is reachable only by Compose services. Mailpit exposes its SMTP and HTTP ports only inside the Compose network and never publishes them to the host.

The Web listener defaults to `127.0.0.1:3920`. PolarPort or another launcher can choose a different host binding without editing Compose:

```bash
POLAR_WEB_BIND=127.0.0.1 POLAR_WEB_PORT=43920 docker compose --profile qa up -d
```

## External PostgreSQL

Provide an operator-managed database and SMTP service, then use the external database Compose file:

```bash
export DATABASE_URL='postgresql://app:password@db.example.internal:5432/polar?sslmode=require'
export AUTH_PEPPER="$(openssl rand -hex 32)"
export PUBLIC_APP_ORIGIN='https://workflow.example.com'
export SMTP_HOST='smtp.example.com' SMTP_PORT=587 SMTP_SECURE=false
export SMTP_FROM='Polar Workflow <no-reply@example.com>'
docker compose -f compose.external-db.yml up --build -d
curl -fsS http://127.0.0.1:3920/readyz
```

Set `SMTP_USERNAME` and `SMTP_PASSWORD` when the SMTP server requires authentication. `DATABASE_URL`, `AUTH_PEPPER`, `PUBLIC_APP_ORIGIN`, and the core SMTP settings are required by `compose.external-db.yml`; Compose stops before startup if any are absent.

The external deployment uses the same `POLAR_WEB_BIND` and `POLAR_WEB_PORT` overrides and also defaults to `127.0.0.1:3920`.

## Migrations and administrator CLI

The API applies the ordered SQL files in `db/migrations` under a PostgreSQL advisory lock before it starts accepting traffic. The same migration runner is used by the administrator CLI.

Create a verified administrator in the bundled deployment:

```bash
docker compose exec web node apps/api/dist/scripts/create-user.js \
  --email admin@example.com \
  --username admin \
  --password 'replace-with-a-strong-password' \
  --verified
```

For the external deployment, add `-f compose.external-db.yml` after `docker compose`. Keep `POSTGRES_PASSWORD`, `AUTH_PEPPER`, database credentials, and SMTP credentials in an operator secret store; do not commit them to Compose or environment files.
