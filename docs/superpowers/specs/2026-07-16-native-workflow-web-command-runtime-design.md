# Native Workflow Web Command Runtime Design

Date: 2026-07-16  
Status: approved parent design specialized for Phase 4 implementation

## 1. Decision and scope

Phase 4 turns the persisted Phase 3 workspace into a real workflow product runtime. It implements:

- append-only Thread messages;
- a workflow HTTP bridge compatible with the existing PolarUI `/run` contract;
- persisted command-event SSE replay and follow;
- durable command idempotency and optimistic Checkpoint-version checks;
- manifest-controlled named actions;
- controlled Thread adoption and Stage advancement;
- durable human-input interrupt and resume handling;
- workflow-generated immutable Checkpoints;
- automatic Route derivation when a shared-state action starts from historical state.

This phase does not implement attachments, object storage, artifact download, editable long-term memory, LibreChat import, a background job fleet, or the PolarFlow IDE. Those remain separate later phases. The native template remains opt-in; legacy remains the default exporter flavor.

The parent architecture and interaction model were already approved in `2026-07-15-native-workflow-web-template-design.md`. This document resolves Phase 4 implementation details without changing that product decision.

## 2. User-visible behavior

Each Stage remains freely browsable. A user may create and select several Threads in any Stage, including a future Stage. Selecting a Thread loads its persisted message timeline.

Thread-local messages:

- call the configured workflow;
- append one user message and one assistant message only after the workflow result is valid;
- never update Stage projections or create a Checkpoint;
- never derive a Route, even when the user is browsing an old Checkpoint.

Named actions:

- are rendered only from the active Stage's manifest `actions` list;
- are disabled while the Stage is `not_started`;
- call the same workflow bridge with an explicit `named_action` field;
- may return validated forward-only Stage signals;
- always create an immutable `workflow_action` Checkpoint after a valid result;
- apply to the current Route when the selected Checkpoint is the Route head;
- automatically create a new Route when the selected Checkpoint is historical.

The generic manifests expose two initial controlled actions:

- `adopt_thread`: adopt the selected Thread result into shared Route history;
- `advance`: apply a validated workflow Stage signal and advance the Route.

An action from historical state creates a derived Route and a derived Thread. The derived Thread references its source Thread but does not duplicate old messages; it contains the action request and assistant result. The source Route, source Thread, and source Checkpoint remain unchanged.

## 3. Persistence model

Migration `0003_workflow_commands.sql` adds:

### `workflow_messages`

Append-only messages scoped to one Thread, Route, Context, and Stage.

Required fields include message ID, command ID, role (`user` or `assistant`), content, monotonically increasing Thread sequence, optional source message reference, and creation time. Update and delete triggers reject mutation with SQLSTATE `55000`.

### `workflow_commands`

One durable row per client-generated UUID command ID. It stores:

- authenticated Context/Route/Stage/Thread scope;
- selected base Checkpoint and expected version;
- command kind (`message`, `named_action`, or `resume_interrupt`);
- action key, interrupt ID, or message content;
- a canonical input hash used to reject command-ID reuse with different input;
- status (`pending`, `running`, `succeeded`, `failed`, or `conflict`);
- attempt and lease metadata;
- result Route, Thread, Checkpoint, and safe error code.

The row is the idempotency key. An identical completed retry replays stored events and does not call the workflow or write domain rows again. A different payload using the same ID returns `COMMAND_ID_REUSED`. A currently leased command returns `COMMAND_IN_PROGRESS`. An expired lease may be reclaimed only before `workflow.started` has been persisted. Once workflow execution may have begun, the server never calls the legacy `/run` endpoint again for that command because product-database idempotency cannot prevent duplicate upstream side effects.

### `workflow_command_events`

Append-only persisted SSE events, ordered by `(command_id, sequence)`. Phase 4 event types are:

- `command.accepted`;
- `workflow.started`;
- `assistant.delta`;
- `workspace.committed`;
- `command.finished`.

Events allow deterministic idempotent replay and future reconnect support even though the current PolarFlow `/run` implementation returns one complete reply rather than token chunks.

### `workflow_interrupts`

One active human-input interrupt may belong to a Thread. It stores a public interrupt ID and prompt, the private workflow cursor required to resume, originating command/action metadata, and `pending` or `resolved` status. Cursor data never appears in browser events or public message responses.

### Existing table extensions

`workflow_threads.origin_thread_id` records a derived historical action Thread. Existing Phase 3 Threads retain `NULL`.

Checkpoint snapshots are extended without breaking old rows. A Phase 4 snapshot contains the Stage array plus command metadata, non-secret memory proposals, adopted Thread ID, and result message IDs. A private pending-interrupt cursor exists only in `workflow_interrupts` and is excluded from browser-readable snapshots. Older snapshots containing only `stages` remain valid.

## 4. Command and transaction model

The browser submits:

```json
{
  "commandId": "client-generated-uuid",
  "kind": "message",
  "content": "current user message",
  "baseCheckpointId": "selected-checkpoint-uuid",
  "expectedCheckpointVersion": 3
}
```

An interrupt reply uses `kind: "resume_interrupt"` plus `interruptId` and `content`. It must match the currently pending owned Thread interrupt.

or:

```json
{
  "commandId": "client-generated-uuid",
  "kind": "named_action",
  "actionKey": "adopt_thread",
  "content": "optional action note",
  "baseCheckpointId": "selected-checkpoint-uuid",
  "expectedCheckpointVersion": 3
}
```

Processing is split so no database transaction is held across the workflow HTTP call:

1. Authenticate and validate Thread/Route/Context/Stage ownership.
2. Validate the action against the manifest and Stage readiness.
3. Insert or load the idempotent command and atomically claim its lease. Return `202` immediately after a successful claim.
4. Confirm the selected Checkpoint and expected version.
5. Read the scoped Thread history and current Route projection snapshot.
6. Call the workflow bridge.
7. Validate the complete workflow result and all Stage signals.
8. In one final transaction, lock the Route and re-check the head guard for an action that began at the current head.
9. Append the user and assistant messages. For an interrupted message command, also persist the pending interrupt and private cursor; for a resume, resolve the previous interrupt and persist any next interrupt.
10. For a named action, append the Checkpoint and update projections; if historical, create the derived Route and derived Thread first.
11. Append final command events and mark the command succeeded.

`baseCheckpointId` and `expectedCheckpointVersion` must always identify the same immutable Checkpoint. A Thread-local message does not depend on the mutable Route head. A named action that begins at the current head records that head as a guard; if the head changes between steps 4 and 8, the transaction writes no messages or Checkpoint and marks the command `conflict`. A named action that deliberately begins at an already historical Checkpoint does not compare against the newer Route head; it derives a Route from the immutable base. A head conflict returns `CHECKPOINT_VERSION_CONFLICT` and the client can refresh or intentionally retry from the now-historical Checkpoint to derive a Route.

## 5. Workflow bridge

`WorkflowBridge` owns all outbound workflow HTTP behavior. The server may override the manifest endpoint with `WORKFLOW_ENDPOINT_OVERRIDE`; this supports container deployment and production QA without exposing the endpoint to the browser.

The bridge maps the native command into the existing `/run` request:

- `userId`: authenticated native user ID;
- `scenarioId`: Context ID;
- `sessionId`: Thread ID;
- `message`: current message, or action label plus optional note;
- `history`: persisted user/assistant messages in ascending order, excluding the current command;
- `memoryPayload`: five-layer scoped snapshot with empty-but-explicit user/context proposal containers, Route/Stage state, and Thread summary;
- `workflowId`: manifest workflow ID;
- `input`: command ID, Route ID, Stage key, Checkpoint version, command kind, and optional `named_action`.

The bridge accepts the legacy `{ ok, reply, memory_delta, pdf_path, step }` response and the Phase 4 additions:

```json
{
  "ok": true,
  "reply": "validated assistant response",
  "stage_signals": [
    { "stage_key": "discover", "status": "completed", "internal_state": "start" },
    { "stage_key": "work", "status": "active", "internal_state": "running" }
  ],
  "workflow_cursor": { "node": "work" },
  "memory_proposals": []
}
```

`stage_signal` singular is normalized to a one-item list for compatibility. Status changes may only move `not_started -> active -> completed`; no Stage position or key may be invented, internal states must exist in the manifest, and the resulting projection must remain an ordered `completed* / active? / not_started*` sequence. A `message` or `resume_interrupt` command returning shared Stage signals fails closed.

For the legacy protocol, `memory_delta.session.polarflow_pending_run` is extracted into a private workflow cursor and normalized as a human-input interrupt. It is not exposed as a memory proposal. A `resume_interrupt` request puts that cursor back into `memoryPayload.session` and sends the user's interrupt reply as `message`. Named actions are passed explicitly through `input.named_action`; they are never represented only as ambiguous natural-language text. `advance` requires at least one valid forward Stage signal, while `adopt_thread` may create a Checkpoint without changing projections.

HTTP errors, timeouts, invalid JSON, `ok: false`, invalid reply types, or invalid Stage signals produce a durable failed command with a safe user error. No message, Stage update, or Checkpoint is committed. Diagnostics are logged server-side and never returned as internal stack or secret data. The bridge never automatically retries a workflow call after timeout, transport failure, or an unknown result.

## 6. HTTP and SSE contract

Authenticated endpoints:

- `GET /api/threads/:threadId/messages` → `{ messages, pendingInterrupt }`, where the interrupt contains only its public ID and prompt
- `POST /api/threads/:threadId/commands` → `202 { commandId, eventUrl }`
- `GET /api/commands/:commandId/events`

The POST endpoint validates, persists, and claims the command, then starts execution independently of the HTTP connection. The GET endpoint uses `Content-Type: text/event-stream`, replays stored events after `Last-Event-ID`, emits heartbeats while the command is non-terminal, and closes after `command.finished`. A completed idempotent POST retry returns the same event URL and never calls the workflow again. Because the current upstream `/run` contract is non-streaming, Phase 4 emits the validated full reply as one `assistant.delta`; the API boundary is ready for real upstream chunks later without changing the browser contract.

Protocol and ownership errors use structured JSON errors. Execution failures and conflicts end with `command.finished` containing a safe outcome and code. Connection loss does not cancel the durable command. SSE responses include `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`.

Mutation routes keep the existing same-origin check. Command execution has a per-user rate limit and never accepts user, Context, Route, or Stage ownership from the request body.

## 7. React integration

The selected Thread panel becomes the persisted conversation workspace:

- load messages on Thread selection and URL restoration;
- render and resume a pending human-input interrupt without exposing its cursor;
- render immutable user/assistant entries;
- provide a composer for Thread-local messages;
- stream `assistant.delta` into a temporary assistant entry;
- reconcile from the server after a successful `command.finished`;
- retain the draft on failure and clear it only after success;
- create one stable UUID command ID per submission and prevent double submit.

Manifest named actions render beside the composer. The UI sends the selected Checkpoint ID and version. On a historical action completion, it follows `resultRouteId` and `resultThreadId` returned by the final event. Version conflict messaging offers refresh and makes clear that retrying intentionally from history will derive a Route.

Stage navigation remains read-only. No generic `set_stage` control is introduced.

## 8. Verification

TDD coverage must include:

- migration idempotency and message/event immutability;
- command-ID replay, payload mismatch, concurrent claim, and expired lease reclaim;
- workflow success, `ok: false`, timeout, invalid JSON, invalid signal, and non-forward signal;
- legacy interrupt extraction, persisted prompt, private cursor, successful resume, and repeated interrupt;
- message commands creating messages without Checkpoints;
- named actions creating one Checkpoint;
- head-version conflicts committing nothing;
- historical named actions creating a Route and derived Thread while preserving the source;
- cross-user command and message isolation;
- SSE formatting, ordered event IDs, `Last-Event-ID` replay, heartbeat/proxy headers, and reconnect after client disconnect;
- React message loading, streaming, double-submit protection, failure draft retention, pending-interrupt refresh/resume, action rendering, conflict display, and historical action navigation.

Production QA extends the Phase 3 Mailpit/Docker/Playwright journey with a real local HTTP workflow process. It proves:

1. two Thread-local messages survive refresh and container recreation;
2. one `adopt_thread` command creates exactly one Checkpoint;
3. a human-input interrupt survives refresh and resumes exactly once;
4. retrying the same command ID does not duplicate messages or Checkpoints;
5. `advance` updates Stage projection forward;
6. a named action from an old Checkpoint creates a new Route and derived Thread;
7. source Route/Checkpoint/messages remain unchanged;
8. cross-user reads and commands return 404;
9. an interrupted SSE connection reconnects from `Last-Event-ID` without re-executing the command;
10. desktop and 390px mobile views remain usable;
11. no LibreChat or Mongo runtime appears.

The release verifier must require migration `0003_workflow_commands.sql`, bridge/runtime modules, and compiled message/command routes before a native release is accepted.

## 9. Completion boundary

Phase 4 is complete only when all unit/integration tests, native/legacy release gates, real PostgreSQL tests, production builds, and the real-container browser journey pass. Attachments, artifacts, object storage, LibreChat import, and native-default cutover remain explicitly unstarted.
