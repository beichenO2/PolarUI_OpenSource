# Native Workflow Web Command Runtime Phase 4 Implementation Plan

> **Status:** Complete on 2026-07-16. Phase 4 passed fresh PostgreSQL workspace tests, production builds, native/legacy release regression, and the Docker/Mailpit/real-workflow/Playwright production journey. Phase 5 remains unstarted.

> **Execution:** Complete inline in the current session. Do not use Superpowers execution orchestration and do not pause for intermediate approval. Ordinary focused subagents may be used for independently testable API, Web, and release tasks; the main agent owns integration and final verification.

**Goal:** Add persisted Thread messages, a compatible PolarFlow HTTP bridge, durable two-endpoint command streaming, idempotency, human-input interrupt/resume, manifest-controlled actions, historical automatic Route derivation, and workflow-generated Checkpoints to the native Web template.

**Architecture:** Add append-only command, event, message, and interrupt storage behind a dedicated command repository. `POST /api/threads/:threadId/commands` validates and durably claims work, returns `202 { commandId, eventUrl }`, and starts execution independently of that request; `GET /api/commands/:commandId/events` replays persisted events and follows the command to its terminal event over SSE. A command service validates manifest permissions and immutable base Checkpoints, calls a strict workflow bridge outside database transactions, then atomically commits messages, interrupt state, and optional Route/Checkpoint changes. A focused React conversation component creates commands, reconnects event streams, reconciles persisted state, and resumes public pending interrupts without ever receiving their private workflow cursor.

**Tech Stack:** PostgreSQL 16, TypeScript, Fastify 5, Zod 4, Node `fetch`/streams, React 19, Vite, Vitest, Docker Compose, Mailpit, Playwright.

---

## File map

- Create `templates/native-web/db/migrations/0003_workflow_commands.sql`: command, event, message, interrupt, derived-Thread schema and immutability triggers.
- Create `templates/native-web/apps/api/src/commands/types.ts`: stored and public command/message contracts.
- Create `templates/native-web/apps/api/src/commands/repository.ts`: idempotent claims, history/interrupt reads, durable events, and final commit transactions.
- Create `templates/native-web/apps/api/src/commands/bridge.ts`: legacy `/run` request mapping, private interrupt-cursor extraction/resume, timeout, normalization, and strict result validation.
- Create `templates/native-web/apps/api/src/commands/service.ts`: manifest authorization, version rules, independent execution orchestration, and persisted event emission.
- Create `templates/native-web/apps/api/src/routes/commands.ts`: authenticated message list, command creation, and command-event SSE replay/follow endpoints.
- Modify `templates/native-web/apps/api/src/config.ts`, `app.ts`, and `server.ts`: workflow endpoint/timeout configuration and runtime wiring.
- Create `templates/native-web/apps/web/src/commands/api.ts`: message/interrupt reads, `createCommand()`, and `streamCommandEvents()` SSE parsing/reconnect support.
- Create `templates/native-web/apps/web/src/commands/ThreadConversation.tsx`: persisted timeline, composer, pending-interrupt resume UI, action buttons, and stream state.
- Modify `templates/native-web/apps/web/src/App.tsx` and `styles.css`: mount the conversation workspace and follow derived Route/Thread results.
- Modify product manifests: register `adopt_thread` and `advance` actions.
- Modify release verifier, packaging tests, README, and production QA: require and exercise Phase 4 runtime files.

### Task 1: Extend manifest-controlled actions

**Files:**
- Modify: `templates/native-web/product.manifest.json`
- Modify: `workflows/claude-code/product.manifest.json`
- Modify: `templates/native-web/packages/product-sdk/tests/manifest.test.ts`

- [x] Write a failing manifest test proving action keys remain unique per Stage and the template/Claude manifests expose `adopt_thread`, while non-final Stages also expose `advance`.
- [x] Run `npm test --workspace @polar/native-web-product-sdk --prefix PolarUI/templates/native-web -- --run` and confirm the new release-action assertion fails.
- [x] Add these manifest entries:

```json
"actions": [
  { "key": "adopt_thread", "label": "采纳到当前路线" },
  { "key": "advance", "label": "推进阶段" }
]
```

The final Stage keeps only `adopt_thread`.
- [x] Rerun the SDK tests and commit with `feat(polarui): declare controlled workflow actions`.

### Task 2: Add append-only command, message, and interrupt schema

**Files:**
- Create: `templates/native-web/db/migrations/0003_workflow_commands.sql`
- Modify: `templates/native-web/apps/api/tests/migrate.integration.test.ts`

- [x] Add failing PostgreSQL assertions for tables `workflow_commands`, `workflow_command_events`, `workflow_messages`, and `workflow_interrupts`, plus `workflow_threads.origin_thread_id`.
- [x] Add failing tests that reject message/event update and delete, invalid Thread scope, duplicate Thread sequence, command payload-hash reuse, invalid result scope, more than one pending interrupt per Thread, and a resolved interrupt being returned as pending.
- [x] Run:

```bash
TEST_DATABASE_URL=postgresql://polar:polar@127.0.0.1:55432/polar \
  npm test --workspace @polar/native-web-api --prefix PolarUI/templates/native-web \
  -- --run tests/migrate.integration.test.ts
```

Expected: FAIL because migration `0003_workflow_commands.sql` and the new tables do not exist.
- [x] Implement the migration with:

```sql
ALTER TABLE workflow_threads
  ADD COLUMN origin_thread_id uuid REFERENCES workflow_threads(id) ON DELETE RESTRICT;

CREATE TABLE workflow_commands (
  id uuid PRIMARY KEY,
  context_id uuid NOT NULL,
  source_route_id uuid NOT NULL,
  source_thread_id uuid NOT NULL,
  stage_key text NOT NULL,
  base_checkpoint_id uuid NOT NULL,
  expected_checkpoint_version integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('message', 'named_action', 'resume_interrupt')),
  action_key text,
  interrupt_id uuid,
  content text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'conflict')),
  attempt integer NOT NULL DEFAULT 0,
  lease_expires_at timestamptz,
  result_route_id uuid,
  result_thread_id uuid,
  result_checkpoint_id uuid,
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
```

Add composite foreign keys back to Context/Route/Thread/Checkpoint scope, append-only event/message tables, unique `(thread_id, sequence)`, unique `(command_id, role)` for command-created messages, and `55000` immutability triggers. Define `workflow_interrupts` with public ID/prompt, private workflow cursor JSON, originating command/action metadata, status constrained to `pending` or `resolved`, resolution command/time fields, and a partial unique index enforcing one pending interrupt per Thread. The browser-visible message/interrupt queries must never select the private cursor.
- [x] Rerun migration plus all API tests and commit with `feat(polarui): persist workflow command runtime`.

### Task 3: Implement command repository transactions

**Files:**
- Create: `templates/native-web/apps/api/src/commands/types.ts`
- Create: `templates/native-web/apps/api/src/commands/repository.ts`
- Create: `templates/native-web/apps/api/tests/command-repository.integration.test.ts`

- [x] Write failing integration tests for:
  - owned Thread state listing messages in ascending sequence plus only the public pending-interrupt ID/prompt;
  - cross-user resources returning `null`;
  - first command claim;
  - identical completed command replay;
  - different payload with the same ID returning `reused`;
  - active lease returning `in_progress`;
  - expired lease reclaim increasing `attempt` only when no `workflow.started` event exists;
  - an expired lease after `workflow.started` becoming a safe terminal unknown-outcome failure without another bridge call;
  - message finalization appending exactly two messages and no Checkpoint;
  - head action finalization appending two messages, one Checkpoint, and forward projections;
  - historical action finalization creating one Route and derived Thread while preserving the source;
  - guarded head conflict committing no messages or Checkpoint;
  - interrupted message finalization persisting a public prompt and private cursor;
  - resume finalization resolving exactly the matching pending interrupt;
  - a resume that interrupts again resolving the old row and creating one new pending interrupt.
- [x] Run the focused test and confirm it fails on the missing module.
- [x] Implement `createCommandRepository(pool)` with these focused methods:

```ts
claimCommand(input): Promise<
  | { kind: 'claimed'; command: WorkflowCommand; execution: CommandExecutionContext }
  | { kind: 'replay'; command: WorkflowCommand; events: WorkflowCommandEvent[] }
  | { kind: 'reused' }
  | { kind: 'in_progress' }
>
listThreadState(userId, threadId): Promise<{
  messages: WorkflowMessage[];
  pendingInterrupt: PublicWorkflowInterrupt | null;
} | null>
appendEvent(commandId, eventType, payload, now): Promise<WorkflowCommandEvent>
finalizeMessage(commandId, result, now): Promise<CommandCommitResult>
finalizeAction(commandId, result, ids, now): Promise<CommandCommitResult>
failCommand(commandId, errorCode, now): Promise<WorkflowCommandEvent[]>
```

`claimCommand` validates `resume_interrupt` against the currently pending owned Thread interrupt and loads its private cursor only into the server-side execution context. `finalizeMessage` persists an optional new pending interrupt and resolves the previous interrupt for a resume in the same transaction. `finalizeAction` locks the command and source Route, derives a Route/Thread only when the immutable base Checkpoint is historical, validates the current-head guard when present, writes message IDs and command metadata into the snapshot, and updates Context recency in the same transaction. No repository return type exposed to routes may contain the private cursor.
- [x] Rerun focused and full API tests; commit with `feat(polarui): transact idempotent workflow commands`.

### Task 4: Build and validate the workflow bridge

**Files:**
- Create: `templates/native-web/apps/api/src/commands/bridge.ts`
- Create: `templates/native-web/apps/api/tests/workflow-bridge.test.ts`
- Modify: `templates/native-web/apps/api/src/config.ts`
- Modify: `templates/native-web/apps/api/tests/config.test.ts`

- [x] Write failing bridge tests that inspect the outbound legacy `/run` body and cover success, singular/plural Stage signals, `ok:false`, non-2xx, redirect rejection, oversized/invalid JSON, invalid reply, timeout across the complete response read, unknown Stage, invalid internal state, backward status, invalid projection ordering, and a message command attempting a shared Stage mutation.
- [x] Add failing bridge tests proving every call sends `Idempotency-Key: <commandId>`, `input.named_action` is present for named actions, `advance` fails without a valid forward Stage signal, and `adopt_thread` may succeed without changing Stage projections.
- [x] Add failing interrupt tests proving `memory_delta.session.polarflow_pending_run` becomes a normalized public prompt plus private cursor, is excluded from memory proposals/public diagnostics, and a `resume_interrupt` call restores only that cursor to `memoryPayload.session` while sending the user's reply as `message`.
- [x] Add configuration tests for optional `WORKFLOW_ENDPOINT_OVERRIDE` URL and positive `WORKFLOW_TIMEOUT_MS` with a 60-second default.
- [x] Implement:

```ts
export interface WorkflowBridge {
  run(input: WorkflowBridgeInput): Promise<WorkflowBridgeResult>;
}

export function createWorkflowBridge(options: {
  endpoint: string;
  workflowId: string;
  manifest: ProductManifest;
  timeoutMs: number;
  fetch?: typeof fetch;
}): WorkflowBridge;
```

Use an abort signal that covers both fetch and response-body reading, `redirect: 'error'`, and a bounded response body. Map native scope into `userId/scenarioId/sessionId/history/memoryPayload/input`, including explicit `input.named_action` for named actions and the private cursor only for a resume. Send `Idempotency-Key: <commandId>`, validate the response with Zod, normalize `stage_signal` to `stage_signals`, extract `polarflow_pending_run`, and return only safe typed data. Never expose endpoint, token, cursor, raw response, diagnostics, or stack. Do not automatically retry any workflow call after timeout or transport failure because product-level command idempotency cannot prevent upstream side effects.
- [x] Run focused tests, config tests, TypeScript build, and commit with `feat(polarui): bridge native commands to workflows`.

### Task 5: Orchestrate message, action, and interrupt-resume commands

**Files:**
- Create: `templates/native-web/apps/api/src/commands/service.ts`
- Create: `templates/native-web/apps/api/tests/command-service.test.ts`

- [x] Write failing unit tests for title/content normalization, manifest action authorization, `not_started` action rejection, immutable base-version mismatch, history/memory snapshot construction, replay without bridge execution, bridge failure persistence, message success without Checkpoint, head action success, historical action IDs, safe conflict events, pending-interrupt ownership, resume cursor injection, and repeated interrupt persistence.
- [x] Implement `createCommandService({ repository, bridge, manifest, createId, now })` with separate `createCommand()` and `executeCommand()` operations. `createCommand()` durably claims or replays the command and returns the stable event URL; `executeCommand()` runs from persisted server state and has no dependency on the POST request signal.
- [x] Compute the canonical input hash from a stable JSON object containing repository-derived scope, base Checkpoint, expected version, kind, action key or interrupt ID, and normalized content. Never trust or hash user ownership supplied by the client.
- [x] Persist event names consistently. A successful command emits `command.accepted`, `workflow.started`, one validated `assistant.delta`, `workspace.committed`, and `command.finished` with outcome `succeeded`. A bridge/runtime failure ends with `command.finished` outcome `failed`; a final head-guard conflict ends with outcome `conflict`. `command.finished` is the only terminal event type. Persist each event before it can be replayed to a client.
- [x] For `resume_interrupt`, require the currently pending owned interrupt, pass its private cursor only to the bridge, resolve it exactly once during final commit, and allow the normalized result to create a new pending interrupt. Identical completed command retries replay persisted events byte-for-byte without another bridge call; timeouts and unknown execution outcomes are never automatically retried.
- [x] Rerun service plus repository tests and commit with `feat(polarui): execute controlled workflow commands`.

### Task 6: Expose command creation and persisted SSE replay

**Files:**
- Create: `templates/native-web/apps/api/src/routes/commands.ts`
- Create: `templates/native-web/apps/api/tests/command-routes.integration.test.ts`
- Modify: `templates/native-web/apps/api/src/app.ts`
- Modify: `templates/native-web/apps/api/src/server.ts`
- Modify: `templates/native-web/apps/api/tests/app.test.ts`

- [x] Write failing Fastify integration tests for unauthenticated `401`, invalid origin `403`, malformed UUID/body `400`, unknown/cross-user Thread or command `404`, public Thread state listing, command-ID reuse `409`, command-in-progress `409`, and the existing per-user mutation rate limit.
- [x] Prove `POST /api/threads/:threadId/commands` returns `202 { commandId, eventUrl: '/api/commands/<id>/events' }` as JSON, completed idempotent retries return the same event URL, and closing the POST connection does not cancel or abort the independently running command.
- [x] Prove `GET /api/commands/:commandId/events` uses `Content-Type: text/event-stream`, frames persisted events as `id: <sequence>\nevent: <type>\ndata: <json>\n\n`, replays only events after numeric `Last-Event-ID`, follows new events, emits comment heartbeats while non-terminal, and closes only after `command.finished`.
- [x] Assert the SSE response includes `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, and connection/keep-alive headers supported by Fastify. Confirm command execution continues if the GET client disconnects and a later GET replays the missing stored events.
- [x] Implement body validation as a discriminated union:

```ts
z.discriminatedUnion('kind', [
  z.object({
    commandId: z.uuid(), kind: z.literal('message'), content: z.string().min(1).max(20_000),
    baseCheckpointId: z.uuid(), expectedCheckpointVersion: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    commandId: z.uuid(), kind: z.literal('named_action'), actionKey: actionKeySchema,
    content: z.string().max(20_000).default(''), baseCheckpointId: z.uuid(),
    expectedCheckpointVersion: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    commandId: z.uuid(), kind: z.literal('resume_interrupt'), interruptId: z.uuid(),
    content: z.string().min(1).max(20_000), baseCheckpointId: z.uuid(),
    expectedCheckpointVersion: z.number().int().nonnegative(),
  }).strict(),
]);
```

- [x] Implement POST as a short JSON request: validate and claim, schedule `executeCommand(commandId)` without passing `request.raw.signal`, then return `202`. Implement GET as persisted replay/follow: validate `Last-Event-ID`, query stored events in sequence, poll or subscribe for later rows, write heartbeats, and terminate after the persisted terminal event. Do not execute workflow logic inside the GET handler.
- [x] Wire configuration, repository, bridge, service, and routes in `server.ts`; classify `/api/commands` failures as safe command-service errors and keep internal endpoint, cursor, diagnostics, and stack data out of JSON/SSE payloads.
- [x] Run all API tests and build; commit with `feat(polarui): stream authenticated workflow commands`.

### Task 7: Add the Web command client

**Files:**
- Create: `templates/native-web/apps/web/src/commands/api.ts`
- Create: `templates/native-web/apps/web/src/commands/api.test.ts`
- Modify: `templates/native-web/apps/web/src/domain/api.ts`

- [x] Write failing tests for Thread state listing with a public pending interrupt, correct command POST payload and `202` response validation, split SSE chunks, multiple frames in one chunk, CRLF framing, `id:` sequence parsing, comment heartbeats, terminal close, reconnect with `Last-Event-ID`, final partial buffer rejection, JSON errors, conflict codes, and stream abort propagation.
- [x] Implement these typed methods using same-origin credentials:

```ts
listThreadState(threadId: string): Promise<{
  messages: WorkflowMessage[];
  pendingInterrupt: PublicWorkflowInterrupt | null;
}>;
createCommand(threadId: string, input: CommandInput): Promise<{
  commandId: string;
  eventUrl: string;
}>;
streamCommandEvents(
  eventUrl: string,
  options: { afterEventId?: number; signal?: AbortSignal },
  onEvent: (event: WorkflowCommandEvent) => void,
): Promise<{ lastEventId: number; finished: CommandFinishedPayload }>;
```

Use `fetch` plus `ReadableStreamDefaultReader` for the GET stream so reconnects can set `Last-Event-ID`. Aborting the local stream must not be presented as command cancellation.
- [x] Parse only `command.accepted`, `workflow.started`, `assistant.delta`, `workspace.committed`, and `command.finished`, validate monotonically increasing numeric event IDs and JSON payloads, ignore heartbeat comments, and reject malformed frames as `COMMAND_STREAM_INVALID`. Throw `CommandApiError(code, status)` for structured POST/GET failures.
- [x] Run Web client tests and commit with `feat(polarui): consume workflow command streams`.

### Task 8: Render persisted conversation and controlled actions

**Files:**
- Create: `templates/native-web/apps/web/src/commands/ThreadConversation.tsx`
- Create: `templates/native-web/apps/web/src/commands/ThreadConversation.test.tsx`
- Modify: `templates/native-web/apps/web/src/App.tsx`
- Modify: `templates/native-web/apps/web/src/App.test.tsx`
- Modify: `templates/native-web/apps/web/src/styles.css`

- [x] Write failing component tests for loading immutable messages and a public pending interrupt, sending one message, optimistic/streaming assistant state, double-submit prevention, failure draft retention, success draft clearing, action labels from manifest, disabled actions in `not_started`, conflict UI, idempotent replay, stream reconnect from the last event ID, and derived Route/Thread completion callbacks.
- [x] Add failing refresh/resume tests proving a pending interrupt reappears after remount, its reply sends `kind: 'resume_interrupt'` with the public interrupt ID, the private cursor never appears in rendered state or requests, successful resolution clears the prompt, and a repeated workflow interrupt replaces it with the next public prompt.
- [x] Implement `ThreadConversation` with props for selected Thread, Stage, Checkpoint, manifest actions, and callbacks `onCommandFinished(result)` and `onConflict()`.
- [x] For every submission, create one stable command UUID, call `createCommand()`, and consume the returned event URL with `streamCommandEvents()`. Render `assistant.delta` separately until a successful `command.finished`, then reload persisted Thread state. Retain the draft after `failed` or `conflict`; clear it only after `succeeded`.
- [x] If the event stream drops before `command.finished`, reconnect to the same event URL with the last received event sequence. Treat component unmount or route navigation as stopping local observation only; the durable command may still finish and reconcile on reload.
- [x] Split the right Thread navigator from the center conversation workspace without changing the approved Context/Route/Stage layout. When no Thread is selected, show a concise prompt to create or choose one.
- [x] On a historical action `command.finished` success, call the existing route opener with returned `resultRouteId`, `resultThreadId`, and active Stage. On a head action success, refresh the current Route workspace and selected messages. Render pending-interrupt input separately from the ordinary composer and disable incompatible actions until the interrupt is resolved.
- [x] Add responsive message/action styling for 1440x900 and 390x844 with accessible labels, status regions, and no horizontal overflow.
- [x] Run all Web tests and build; commit with `feat(polarui): add workflow conversation workspace`.

### Task 9: Gate Phase 4 release packaging

**Files:**
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/verify-release.test.mjs`
- Modify: `scripts/native-identity-packaging.test.mjs`
- Modify: `templates/native-web/README.md`

- [x] Add failing verifier tests for missing `0003_workflow_commands.sql`, compiled command routes, command service, bridge, and Web command client.
- [x] Add packaging assertions that the production image contains the new migration and compiled runtime modules.
- [x] Update README with the `POST`-202 command creation and `GET`-SSE event endpoints, `Last-Event-ID` replay, heartbeats/proxy headers, workflow override/timeout environment variables, idempotency/no automatic upstream retry, public interrupt resume behavior, and the Phase 4/Phase 5 boundary.
- [x] Run focused release tests, native release regression, and legacy-default regression; commit with `test(polarui): gate workflow command releases`.

### Task 10: Extend real production QA

**Files:**
- Modify: `scripts/qa-native-identity-release.mjs`

- [x] Start a real local HTTP workflow server inside the QA process. It must count calls and return:
  - echo replies for message commands;
  - `memory_delta.session.polarflow_pending_run` with a public prompt/private cursor for a dedicated interrupt message, then a resumed reply after that cursor returns in `memoryPayload.session`;
  - no Stage signal for `adopt_thread`;
  - forward `discover=completed`, `work=active` signals for `advance`;
  - a safe failure for a dedicated failure message.
- [x] Pass `WORKFLOW_ENDPOINT_OVERRIDE=http://host.docker.internal:<port>/run` and `WORKFLOW_TIMEOUT_MS=5000` into bundled and external Web containers.
- [x] Extend the browser journey to select a Thread, send two messages, trigger a human-input interrupt, reload the page, verify the pending prompt survives, resume it once, reload again, and confirm the resolved prompt does not return. Then run `adopt_thread`, replay the same command ID through POST plus GET SSE, run `advance`, browse Checkpoint 00, execute a historical named action, and follow the derived Route/Thread.
- [x] Query PostgreSQL to assert exact command/message/event/interrupt/Checkpoint counts, one resolved interrupt with no duplicate resume effect, private cursor persistence without browser/API exposure, the ordered success events `command.accepted` / `workflow.started` / `assistant.delta` / `workspace.committed` / `command.finished`, command replay without an extra workflow call, source immutability, derived Thread lineage, and no cross-user access.
- [x] Drop an SSE connection before completion, reconnect with `Last-Event-ID`, and prove the command completes once and replays only missing events. Inspect response headers for `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`.
- [x] Force-recreate the Web container and verify the selected derived URL plus messages recover. Repeat essential assertions at 390x844 and against external `DATABASE_URL` mode.
- [x] Preserve `[QA PASS] native workflow command production release` as the only success marker.
- [x] Run `npm run qa:native-domain --prefix PolarUI` and commit with `test(polarui): verify workflow command production journey`.

### Task 11: Final verification and completion boundary

- [x] Run `git diff --check` and syntax checks for release/QA scripts.
- [x] Run all native template tests against a fresh PostgreSQL 16 container.
- [x] Run the complete native build, verifier, export, packaging, and legacy-default regression gates.
- [x] Run the full Docker/Mailpit/real-workflow/Playwright production QA and confirm `[QA PASS] native workflow command production release`.
- [x] Confirm `git status --short -- PolarUI` is empty and remove dedicated PostgreSQL/QA resources.
- [x] Mark this plan complete. Record Phase 5 as unstarted: attachments, artifact/object storage, optional memory proposal management, LibreChat archive import, and native-default cutover.
