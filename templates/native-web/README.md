# Polar Native Workflow Web Template

This directory is the tracked source for native Polar Workflow Web releases. The UI is conversation-first and independent from the legacy chat runtime: users can provide Workflow Input immediately, while Context, Route, Conversation, Checkpoint, memory, Artifact, and attachment ownership remain durable server-side concepts.

## Domain hierarchy

```text
User -> Context -> Route -> Conversation
                     └-> immutable Checkpoints -> optional Stage Projection snapshots

User memory: cross-Context
Context memory: current Context only
```

- A Context is the shared situation and Context-memory boundary.
- A Conversation is a local message and draft history. It is not a Workflow branch.
- A Route is an equal-status Workflow timeline. Its Checkpoints are append-only and immutable.
- Stage Projection is optional, read-only, and returned by the Workflow. Its names, count, order, and statuses are never Web-owned navigation state.
- An Artifact is a Workflow result. It appears in the causal Conversation timeline and in the inspector's Artifact summary.

The desktop shell keeps the Context sidebar, Conversation axis, and memory/Artifact/run inspector in DOM and visual order. Compact layouts keep a single Conversation scroll; Contexts, Conversation management, inspector content, Stage Projection details, and archives open as full-screen layers. The Input composer remains above the safe area.

## Unified Command lifecycle

All user messages, named intents, and Interrupt replies use one durable Command endpoint:

```text
POST /api/workflow/commands
GET  /api/commands/:commandId/events
```

The public Command binds interaction to a timeline, not to a Stage:

```text
commandId
contextId?
routeId?
conversationId?
baseCheckpointId?
expectedCheckpointVersion?
input: message | named_intent | resume_interrupt
attachmentIds[]
```

Command creation returns `202` with a stable command ID and authenticated event URL. The SSE stream persists and replays `command.accepted`, `workflow.started`, `assistant.delta`, `workspace.committed`, and terminal `command.finished` events. Reconnect with `Last-Event-ID`. Reusing a command ID with identical input replays its receipt; reusing it with different input is rejected.

### Hidden initialization

At zero Context, the first Input starts one atomic initialization Command. The server provisions the Context, initial Route, primary Conversation, and Checkpoint privately, invokes the Workflow, and activates them only after success. The Agent may return Context and Conversation names. If the attempt fails, the provisional records remain hidden and the exact Input and attachment IDs remain available for retry.

An existing Context with no Conversation exposes a virtual primary Conversation. `+` creates an untitled virtual Conversation immediately; its first successful Command materializes and may name it without a title form.

### History and automatic branching

Browsing an earlier Checkpoint is read-only and does not create a Route. Sending Input while a non-head Checkpoint is selected atomically creates a new equal-status Route from that exact Checkpoint, creates its Conversation, and executes the Workflow. Failure leaves no visible empty Route. The source Route, source messages, source artifacts, source Checkpoint Input, and historical Stage Projection snapshot remain unchanged.

### Name locks

Agent naming only applies while Context or Conversation title ownership is `agent`. A manual rename changes title ownership to `user`; later Workflow results cannot overwrite it. Rename changes display metadata only: it never runs the Workflow, creates a Checkpoint, changes memory, or branches a Route. Enter saves, Escape cancels, and either path restores focus to the rename trigger.

## Workflow result contract

The Bridge sends the Workflow a versioned envelope containing Context/Route/Conversation IDs, the base Checkpoint and version, public Input, opaque attachment IDs, local history, both memory scopes, and the immutable Checkpoint snapshot. It never sends a user-selected `stage_key` or `setStage` action.

A v2 Workflow result can return:

```text
reply_events
checkpoint.workflow_state
context_title?
conversation_title?
memory_updates[]
artifact_proposals[]
stage_projection?
interrupt?
diagnostics
```

`stage_projection` is self-describing and dynamic. Zero items hides the module; one item renders one status; 2–6 render directly; 7+ render a summary with a full vertical detail layer. Each Checkpoint stores its complete projection snapshot, so later Workflow-definition changes cannot rewrite history.

## Two memory layers

User memory models stable habits, characteristics, decision style, and taste across Contexts. Context memory models goals, facts, decisions, constraints, materials, and Artifact references that remain useful only in the current Context.

Every memory record exposes scope, source, created and updated timestamps, version, impact scope, evidence references, and status. Updates are optimistic and append-only: correction creates a new version, while deletion writes an auditable invalidation instead of erasing history. Conflicting or high-impact updates produce a Workflow Interrupt and cannot silently replace the active version. Only the public Interrupt ID and prompt reach the browser; its private cursor stays server-side.

```text
GET    /api/memory?scope=user
GET    /api/memory?scope=context&context=:contextId
GET    /api/memory/:memoryId/versions
PATCH  /api/memory/:memoryId
DELETE /api/memory/:memoryId
```

## Workspace and asset endpoints

All endpoints derive ownership from the HttpOnly session. Mutations also require the configured same-origin `Origin` header.

```text
GET   /api/contexts
POST  /api/contexts                         # optional manual entry
GET   /api/contexts/:contextId/workspace
PATCH /api/contexts/:contextId

GET   /api/routes/:routeId/workspace?checkpoint=:checkpointId
POST  /api/routes/:routeId/conversations
PATCH /api/conversations/:conversationId
GET   /api/conversations/:conversationId/messages

POST   /api/attachments/staged
DELETE /api/attachments/staged/:attachmentId
GET    /api/conversations/:conversationId/attachments
GET    /api/assets/:kind/:assetId/download

GET /api/archive/conversations
GET /api/archive/conversations/:conversationId
```

Attachments and Workflow Artifacts use SHA-256-addressed object storage. Uploads are limited to 25 MB; downloads use opaque IDs, ownership checks, `Content-Disposition: attachment`, and `X-Content-Type-Options: nosniff`. Imported LibreChat conversations remain read-only.

The one-shot archive importer supports a write-free review before mutation:

```bash
npm run import:librechat -- \
  --input /imports/librechat-export.json \
  --attachments-dir /imports/files \
  --target-user user@example.com \
  --dry-run
```

Remove `--dry-run` only after reviewing its machine-readable report. For a direct Mongo source, provide `LIBRECHAT_MONGO_URI` through the operator secret environment and use `--source-user` when needed; the importer only reads the source database.

## Governed runtime

Do not start Vite, the API, Docker Compose, PostgreSQL, Mail capture, or QA services directly, and do not assign fixed local ports in ad-hoc shell commands.

Runtime truth is declared in the repository-level `polaris.json`. `Start/start.sh` is the governed project entrypoint. PolarPort is the sole port allocator and ownership authority; PolarProcess is the sole long-running process registry and lifecycle authority. Preview, development, release QA, and restart verification must use those declarations and authorities. If the runtime-governance audit reports a hard conflict, stop rather than falling back to an unmanaged process.

Operator secrets such as `DATABASE_URL`, `AUTH_PEPPER`, SMTP credentials, `PUBLIC_APP_ORIGIN`, and Workflow endpoint overrides belong in the governed environment or secret store, never in tracked files.

## Transient development gates

Dependency installation, unit tests, and builds terminate with the invoking command and do not bind a persistent port:

```bash
npm install
npm test
npm run build
```

Run the repository aggregate gate from the `PolarUI` root with `npm run test:native-web`. PostgreSQL integration suites require a governed `TEST_DATABASE_URL`; when it is absent they report an explicit skip and must not be described as passed.

Production browser/restart verification is the separate governed `qa:native-release` workflow. It may run only after the PolarPort/PolarProcess health checks and runtime audit defined by the project plan. Record evidence in `polaris.json` only from the actual logs; never infer a pass from unit or build results.
