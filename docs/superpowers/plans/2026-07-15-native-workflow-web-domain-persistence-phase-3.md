# Native Workflow Web Domain Persistence Phase 3 Implementation Plan

> **Execution:** Complete inline in the current session. Do not use Superpowers execution orchestration and do not pause for intermediate approval.

**Goal:** Persist and expose the authenticated `Context -> Route -> Stage -> Thread -> Checkpoint` hierarchy in the native Web template, including historical Route branching and production browser evidence.

**Architecture:** Add an append-only PostgreSQL domain schema behind a dedicated repository and service. Fastify routes derive user scope from the existing opaque session, while React renders URL-addressable server state. The product manifest remains the source of Stage definitions; PostgreSQL stores only per-Route projections and immutable snapshots.

**Tech Stack:** PostgreSQL 16, TypeScript, `pg`, Fastify, Zod, React, Vite, Vitest, Node test runner, Docker Compose, Mailpit, Playwright.

---

## File map

- Create `templates/native-web/db/migrations/0002_workflow_domain.sql`: domain tables, indexes, immutable checkpoint trigger, route-head validation.
- Create `templates/native-web/apps/api/src/domain/types.ts`: public and stored domain contracts.
- Create `templates/native-web/apps/api/src/domain/repository.ts`: parameterized PostgreSQL persistence and ownership queries.
- Create `templates/native-web/apps/api/src/domain/service.ts`: manifest validation, bootstrap, branch, and mutation rules.
- Create `templates/native-web/apps/api/src/routes/domain.ts`: authenticated HTTP contract.
- Modify `templates/native-web/apps/api/src/auth/service.ts`: expose session lookup for domain authorization without duplicating token rules.
- Modify `templates/native-web/apps/api/src/app.ts` and `src/server.ts`: register the domain service and sanitize domain failures.
- Create `templates/native-web/apps/web/src/domain/api.ts`: typed domain HTTP client.
- Create `templates/native-web/apps/web/src/domain/WorkspaceApp.tsx`: Context empty state and persisted workspace controller.
- Modify `templates/native-web/apps/web/src/App.tsx`: render persisted hierarchy instead of placeholder data.
- Modify `templates/native-web/apps/web/src/styles.css`: Context creation, Route/Checkpoint navigation, Thread forms, responsive states.
- Modify native release verifier and QA script: require domain migration and exercise the production journey.

### Task 1: Define database invariants

- [x] Add a migration integration test that expects five domain tables, foreign keys, unique Route versions, and immutable Checkpoints.
- [x] Run the migration test against PostgreSQL and confirm it fails because migration `0002_workflow_domain.sql` is absent.
- [x] Add `0002_workflow_domain.sql` with `contexts`, `workflow_routes`, `workflow_checkpoints`, `route_stage_projections`, and `workflow_threads`.
- [x] Add a trigger function that raises SQLSTATE `55000` on Checkpoint update/delete and a deferred trigger that rejects a Route head outside its Route.
- [x] Rerun migration and full API tests; commit with `feat(polarui): add workflow domain schema`.

### Task 2: Implement the repository transaction model

- [x] Write PostgreSQL integration tests for Context bootstrap, ordered Context listing, workspace ownership, Stage Thread isolation, archive/rename, and Route branching from a historical Checkpoint.
- [x] Confirm the new tests fail on the missing repository module.
- [x] Implement `createDomainRepository(pool)` with explicit parameterized SQL and `withTransaction` for bootstrap and branch operations.
- [x] Persist snapshot JSON from the same Stage projection values written in each transaction.
- [x] Verify the source Route head and source Checkpoint row remain byte-for-byte unchanged after branching.
- [x] Run all repository tests and commit with `feat(polarui): persist workflow domain hierarchy`.

### Task 3: Enforce manifest and ownership rules in a service

- [x] Write unit tests for trimmed title limits, unknown Stage rejection, first-Stage bootstrap state, cross-user not-found behavior, and branch naming defaults.
- [x] Confirm they fail on the missing service module.
- [x] Implement `createDomainService({ repository, manifest, createId, now })` and typed domain errors.
- [x] Ensure the service accepts only authenticated `userId` scope and never accepts user ownership from request bodies.
- [x] Run unit plus integration tests and commit with `feat(polarui): enforce workflow domain rules`.

### Task 4: Add authenticated domain APIs

- [x] Write Fastify integration tests for unauthenticated `401`, invalid origin `403`, malformed bodies `400`, cross-user `404`, Context creation, Thread mutation, workspace reads, and historical Route branching.
- [x] Confirm the route tests fail with `404` before registration.
- [x] Add `routes/domain.ts`, reuse the existing session cookie/token digest logic through the auth service, and add Zod path/query/body schemas.
- [x] Register routes in `app.ts`, wire repository/service in `server.ts`, and sanitize unexpected `/api/domain` failures as `DOMAIN_SERVICE_UNAVAILABLE`.
- [x] Run the complete  API suite against PostgreSQL and commit with `feat(polarui): expose workflow domain api`.

### Task 5: Replace placeholder Web data with a typed client

- [x] Write client tests for Context list/create, Route workspace, Thread create/update, and Route branch requests.
- [x] Confirm they fail because `domain/api.ts` does not exist.
- [x] Implement one same-origin JSON request helper with typed error codes and `credentials: same-origin`.
- [x] Preserve the authentication client's existing public behavior.
- [x] Run Web tests and commit with `feat(polarui): add workflow domain web client`.

### Task 6: Implement Context and URL-addressable workspace state

- [x] Write React tests for the no-Context creation screen, automatic navigation to the new main Route, persisted reload, Context switching, and unknown URL recovery.
- [x] Confirm the current placeholder App fails those assertions.
- [x] Add `WorkspaceApp.tsx` to load Contexts, parse `/contexts/:contextId/routes/:routeId/stages/:stageKey`, and navigate with `history.pushState`.
- [x] Keep authentication return URLs and local drafts keyed by the complete workspace location.
- [x] Run Web tests and commit with `feat(polarui): add persisted context workspace`.

### Task 7: Implement Stage, Checkpoint, Route, and Thread interactions

- [x] Write React tests proving Stage clicks are navigation-only, two Threads can exist in one Stage, Threads are isolated across Stages, Checkpoint selection shows historical mode, and branching navigates to a new Route while preserving the old one.
- [x] Confirm the tests fail before interaction controls exist.
- [x] Replace placeholder Context/Route/Thread cards with server responses, add the Checkpoint timeline, Thread create/rename/archive forms, and the explicit historical branch button.
- [x] Do not add message send, workflow advance, adoption, or artifact controls.
- [x] Run all Web tests and commit with `feat(polarui): render workflow hierarchy controls`.

### Task 8: Complete responsive and accessible styling

- [x] Add DOM assertions for labels, current Stage, selected Route, historical warning, error notices, and keyboard-reachable controls.
- [x] Extend the existing minimal field-notes visual language without release-specific branding.
- [x] Make the hierarchy usable at 1440x900 and 390x844 with no horizontal page overflow.
- [x] Run Web tests and production build; commit with `style(polarui): refine persisted workflow workspace`.

### Task 9: Gate native release packaging

- [x] Add verifier tests that fail when `0002_workflow_domain.sql` or the domain runtime modules are missing.
- [x] Add packaging tests that confirm the production image includes the migration and compiled domain routes.
- [x] Update verification rules and README API/deployment documentation.
- [x] Run focused release tests and both native/legacy regression gates; commit with `test(polarui): gate workflow domain releases`.

### Task 10: Extend production end-to-end QA

- [x] Extend the existing identity QA after login to create a Context, navigate a manifest Stage, create two Threads, choose the bootstrap Checkpoint, create a new Route, refresh, and verify both Routes remain.
- [x] Query PostgreSQL inside the bundled container to prove Checkpoint immutability and cross-user ownership.
- [x] Force-recreate the Web container and verify the selected Route/Stage/Thread URL and server data recover.
- [x] Repeat essential rendering assertions at 390x844 and verify external-DB readiness.
- [x] Rename the pass marker to `[QA PASS] native workflow domain production release`.
- [x] Run the complete production QA and commit with `test(polarui): verify workflow domain production journey`.

### Task 11: Final verification

- [x] Run `git diff --check` and syntax checks for modified release scripts.
- [x] Run all native template tests against a fresh PostgreSQL 16 container.
- [x] Run the production build, native release tests, legacy-default regression, and production QA from exported Compose files.
- [x] Confirm PolarUI has no uncommitted changes and remove dedicated QA resources.
- [x] Record Phase 4 as the unstarted boundary: Workflow Bridge, messages, SSE, command idempotency, controlled adoption/actions, and workflow-generated Checkpoints.
