# Native Workflow Web Assets, Archive Migration, and Cutover Phase 5 Implementation Plan

> **Status:** Complete on 2026-07-16. Fresh template tests/builds, PostgreSQL 16 integration suites, native/legacy release gates, and Docker/Mailpit/real-workflow/Playwright production QA all passed.

> **For agentic workers:** Execute task-by-task with ordinary SubAgents when available. The main agent owns every acceptance rerun and commit.

**Goal:** Complete the native workflow Web template with durable attachments/artifacts, explicit memory-proposal decisions, read-only LibreChat archive migration, and native-by-default release export.

**Architecture:** PostgreSQL remains the metadata and authorization source of truth. Binary bodies are addressed by SHA-256 through a replaceable object-store adapter, while browser APIs only expose owned opaque IDs. Workflow results may propose bounded inline artifacts; command finalization commits metadata after object persistence. LibreChat migration is a separate idempotent CLI that writes immutable archive tables and never adds a runtime Mongo dependency to the Web server.

**Tech Stack:** Node.js 22, TypeScript, Fastify, PostgreSQL 16, React/Vite, Vitest/Node test runner, Docker Compose, Playwright.

---

### Task 1: Freeze the Phase 5 persistence contract

**Files:**
- Create: `templates/native-web/db/migrations/0004_assets_memory_archive.sql`
- Test: `templates/native-web/apps/api/tests/migrate.integration.test.ts`

- [x] Add append-only object, attachment, artifact, memory-proposal, memory-entry, and LibreChat archive tables with ownership/scope foreign keys, hashes, state constraints, and migration idempotency.
- [x] Add integration assertions for mutation rejection, duplicate-source import idempotency, and cross-scope foreign-key rejection.
- [x] Add migration `0004`, rerun the focused test, and commit the green persistence slice.

### Task 2: Add bounded object storage and owned asset APIs

**Files:**
- Create: `templates/native-web/apps/api/src/assets/storage.ts`
- Create: `templates/native-web/apps/api/src/assets/repository.ts`
- Create: `templates/native-web/apps/api/src/assets/service.ts`
- Create: `templates/native-web/apps/api/src/routes/assets.ts`
- Modify: `templates/native-web/apps/api/src/config.ts`
- Modify: `templates/native-web/apps/api/src/app.ts`
- Modify: `templates/native-web/apps/api/src/server.ts`
- Test: `templates/native-web/apps/api/tests/asset-service.test.ts`
- Test: `templates/native-web/apps/api/tests/asset-routes.integration.test.ts`

- [x] Write tests for filename/media validation, byte and proposal-count limits, SHA-256 deduplication, thread ownership, safe download headers, and cross-user 404 behavior.
- [x] Implement bounded local-volume ingestion behind an `ObjectStore` interface with SHA-256-addressed atomic temporary files, and expose authenticated attachment create/list/download endpoints.
- [x] Persist workflow artifacts through the same owned metadata path; failed writes remain `failed` and never expose a missing body as ready.
- [x] Run the focused suites and commit the green asset slice.

### Task 3: Persist workflow artifacts and memory proposals

**Files:**
- Modify: `templates/native-web/apps/api/src/commands/bridge.ts`
- Modify: `templates/native-web/apps/api/src/commands/types.ts`
- Modify: `templates/native-web/apps/api/src/commands/repository.ts`
- Modify: `templates/native-web/apps/api/src/commands/service.ts`
- Create: `templates/native-web/apps/api/src/memory/repository.ts`
- Create: `templates/native-web/apps/api/src/memory/service.ts`
- Create: `templates/native-web/apps/api/src/routes/memory.ts`
- Test: `templates/native-web/apps/api/tests/workflow-bridge.test.ts`
- Test: `templates/native-web/apps/api/tests/command-repository.integration.test.ts`
- Test: `templates/native-web/apps/api/tests/memory-routes.integration.test.ts`

- [x] Write tests proving invalid/oversized artifact proposals fail closed, valid proposals become owned ready artifacts, memory proposals remain pending, and only their owner can adopt or reject once.
- [x] Extend the bridge envelope with strict bounded artifact proposals and legacy `pdf_path` normalization through the configured shared artifact root.
- [x] Commit artifact metadata and proposal rows with successful command results; add list/adopt/reject APIs and immutable adopted memory entries.
- [x] Rerun all command, bridge, and memory tests and commit the green command-integration slice.

### Task 4: Add fixed stage workspaces, uploads, artifacts, and proposal review to React

**Files:**
- Create: `templates/native-web/apps/web/src/assets/api.ts`
- Create: `templates/native-web/apps/web/src/assets/AssetPanel.tsx`
- Create: `templates/native-web/apps/web/src/memory/ProposalPanel.tsx`
- Create: `templates/native-web/apps/web/src/stages/StageWorkspace.tsx`
- Modify: `templates/native-web/apps/web/src/App.tsx`
- Modify: `templates/native-web/apps/web/src/commands/ThreadConversation.tsx`
- Modify: `templates/native-web/apps/web/src/styles.css`
- Test: `templates/native-web/apps/web/src/assets/AssetPanel.test.tsx`
- Test: `templates/native-web/apps/web/src/stages/StageWorkspace.test.tsx`

- [x] Write UI tests for the four fixed component keys, attachment selection/upload, artifact download, proposal adoption/rejection, keyboard operation, and 390px-safe layout hooks.
- [x] Implement a non-recursive component registry for `generic_chat`, `structured_form`, `card_selection`, and `document_workspace`; every workspace keeps the native Thread conversation available.
- [x] Add attachment and artifact panels plus explicit proposal decisions without exposing storage keys or workflow-local paths.
- [x] Run Web tests and production build, then commit the green UI slice.

### Task 5: Add idempotent LibreChat read-only archive import

**Files:**
- Create: `templates/native-web/apps/api/src/archive/import-librechat.ts`
- Create: `templates/native-web/apps/api/src/archive/repository.ts`
- Create: `templates/native-web/apps/api/src/routes/archive.ts`
- Create: `templates/native-web/apps/api/src/scripts/import-librechat.ts`
- Modify: `templates/native-web/apps/api/package.json`
- Modify: `templates/native-web/package.json`
- Test: `templates/native-web/apps/api/tests/librechat-import.integration.test.ts`
- Test: `templates/native-web/apps/api/tests/archive-routes.integration.test.ts`
- Create: `templates/native-web/apps/api/tests/fixtures/librechat-export.json`

- [x] Write tests for dry-run counts, source-ID preservation, roles/timestamps, attachment hash checks, repeated import, partial failure reporting, owner isolation, and archive write rejection.
- [x] Implement JSON-export and read-only `mongosh` inputs, explicit target-user mapping, idempotent deterministic source keys, and machine-readable reports.
- [x] Expose authenticated archive list/detail/download reads; do not permit replies or conversion of archive messages into native mutable Threads.
- [x] Run focused archive tests and commit the green importer slice.

### Task 6: Cut native export over to the default and harden release gates

**Files:**
- Modify: `scripts/export-release.mjs`
- Modify: `scripts/export-release.test.mjs`
- Modify: `scripts/native-template.test.mjs`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/verify-release.test.mjs`
- Modify: `templates/native-web/Dockerfile`
- Modify: `templates/native-web/compose.yml`
- Modify: `templates/native-web/compose.external-db.yml`
- Modify: `templates/native-web/.env.example`
- Modify: `templates/native-web/README.md`

- [x] Write exporter and verifier tests proving omitted flavor selects native, `--template-flavor legacy` remains an explicit compatibility path, and native releases require migration `0004`, asset/archive modules, object-volume configuration, and no LibreChat/Mongo runtime.
- [x] Change the CLI/default API flavor to native, retain explicit legacy export, and update packaging/configuration and operator documentation.
- [x] Run exporter/native/legacy verifier suites and commit the green cutover slice.

### Task 7: Production journey and final closure

**Files:**
- Modify: `scripts/qa-native-identity-release.mjs`
- Modify: `package.json`
- Modify: `docs/WEB_ACCEPTANCE.md`
- Modify: this plan

- [x] Extend the real release journey through registration, Mailpit verification, login, Context/Thread creation, attachment persistence, workflow artifact creation, memory decision, refresh/container recreation, archive dry-run/import/idempotency/read-only verification, forward Stage advancement, and historical Route derivation.
- [x] Run `npm test` in `templates/native-web`, `npm run build` in `templates/native-web`, the release verifier suites, and the real Docker/PostgreSQL/Mailpit/Playwright QA command; record exact zero-failure evidence.
- [x] Mark every task complete only after fresh main-agent verification, remove QA resources, confirm `git status --short -- PolarUI` contains only the Phase 5 closure changes, and commit the completed plan.

## Final verification evidence

- `npm test && npm run build` in `templates/native-web`: API 98 passed / 56 integration-gated, Web 53 passed, SDK 7 passed; all three production builds exited 0.
- Fresh PostgreSQL 16 transient integration environment: 8 files and 64 tests passed, including migration `0004`, command transactions, ownership, immutability, and memory decision finality.
- `node --test scripts/native-template.test.mjs scripts/verify-release.test.mjs scripts/native-identity-packaging.test.mjs scripts/export-release.test.mjs`: 41/41 passed across native default, explicit legacy compatibility, packaging, and verifier gates.
- `npm run qa:native-identity`: `[QA PASS] native workflow command production release`; the real release covered Mailpit registration, login, attachments, workflow artifacts, memory adoption, archive dry-run/import/repeat/read-only UI, restart persistence, Stage advancement, historical Route derivation, mobile layout, external PostgreSQL, and zero LibreChat/Mongo runtime dependencies.
