# Native Workflow Web Core Input and Memory Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Native Workflow Web around always-available Workflow Input, Context/Conversation interaction, two-layer versioned memory, immutable Checkpoints, and optional dynamic Stage Projections.

**Architecture:** Keep the existing Fastify/PostgreSQL/React release template, but replace the Stage-first public contract with one unified Command contract whose scope is either zero-Context bootstrap or an existing Context/Route/optional Conversation/Checkpoint. PostgreSQL remains the authority for idempotency, optimistic concurrency, append-only history, hidden initialization, automatic historical branching, memory versions, and source metadata; the Workflow Bridge owns FSM execution and returns optional self-describing Stage Projections. The React application becomes a conversation-first shell with a persistent composer, Context and Conversation management, a two-layer memory inspector, read-only history, and responsive Stage Projection summaries.

**Tech Stack:** Node.js 22, TypeScript, Fastify 5, PostgreSQL 16, React 19, Vite 6, Vitest 3, Testing Library, Docker Compose, Playwright, PolarPort, and PolarProcess.

---

## Execution constraints and protected baseline

- Work in `~/Polarisor/PolarUI` on `dev/polarui-ui` unless the user explicitly chooses another branch.
- The confirmed specification is `docs/superpowers/specs/2026-07-17-native-workflow-web-core-input-design.md` from commit `3ff84ed`; it is the sole product/UI baseline.
- The worktree already contains extensive user changes, including modified Native Web API/Web files and untracked `apps/web/src/workspace/`, QA scripts, fixtures, and plans. Never reset, checkout, clean, stash, or overwrite them.
- Before every task, capture `git status --short` plus `git diff -- <task paths>` and compare after the task. Stage only new task hunks with `git add -p -- <task paths>`; inspect `git diff --cached` before any commit. If a new hunk cannot be separated from a protected user hunk, leave it uncommitted and report the overlap instead of committing the whole file.
- Do not use `git add -A`, `git add .`, broad formatter rewrites, or pathless commits.
- Current transient test baseline (2026-07-17): `npm test` in `templates/native-web` passes 172 tests; 55 PostgreSQL integration tests are skipped without `TEST_DATABASE_URL`.
- Unit tests, builds, format checks, and migrations against an ephemeral test process are transient. Any preview, API server, Workflow runtime, database container, mail capture, browser QA topology, or other persistent listener must follow `polar-runtime-governance`: read the runtime contract, run the project audit, use PolarPort for every binding, and use the exact PolarProcess service action. Do not run raw `npm run dev`, `vite`, `node ...server`, `docker compose up`, background processes, or direct signals.

## Target file map

### Database and API

- Create `templates/native-web/db/migrations/0005_core_input_memory.sql`: additive/compatibility migration for initializing scopes, Conversation metadata, Stage-independent command scope, dynamic Checkpoint snapshots, staged attachments, and two-layer memory versions.
- Modify `templates/native-web/apps/api/src/domain/types.ts`: authoritative Context, Route, Conversation, Checkpoint, Stage Projection, and snapshot types.
- Modify `templates/native-web/apps/api/src/domain/repository.ts`: Context/Route/Conversation reads, manual rename locks, read-only history, and legacy-row compatibility.
- Modify `templates/native-web/apps/api/src/domain/service.ts`: validation and rename/archive orchestration without Workflow side effects.
- Modify `templates/native-web/apps/api/src/routes/domain.ts`: Stage-free workspace routes and Context/Conversation rename APIs.
- Modify `templates/native-web/apps/api/src/commands/types.ts`: unified Command target, execution context, Workflow result, and terminal event types.
- Modify `templates/native-web/apps/api/src/commands/repository.ts`: transactional bootstrap, virtual Conversation materialization, historical Route creation, append-only Checkpoints, memory/attachment adoption, and idempotent finalization.
- Modify `templates/native-web/apps/api/src/commands/service.ts`: scope normalization, Bridge execution, name locking, conflict handling, and safe failure behavior.
- Modify `templates/native-web/apps/api/src/commands/bridge.ts`: Stage-independent request contract, two memory payloads/extraction goals, optional dynamic Stage Projection, naming suggestions, interrupts, and diagnostics filtering.
- Modify `templates/native-web/apps/api/src/routes/commands.ts`: unified `/api/workflow/commands` mutation plus owned Conversation message reads and SSE observation.
- Create `templates/native-web/apps/api/src/memory/types.ts`: public memory item/version metadata and mutation input types.
- Create `templates/native-web/apps/api/src/memory/service.ts`: list, revise, invalidate, conflict, and ownership rules.
- Modify `templates/native-web/apps/api/src/memory/repository.ts`: active two-layer reads and append-only version writes.
- Modify `templates/native-web/apps/api/src/routes/memory.ts`: user/context list, detail, revise, and invalidate endpoints.
- Modify `templates/native-web/apps/api/src/assets/repository.ts`, `src/assets/service.ts`, and `src/routes/assets.ts`: user-owned staged uploads that are adopted only by successful Commands.
- Modify `templates/native-web/apps/api/src/app.ts` and `src/server.ts`: wire new services without changing runtime ownership.

### Workflow/manifest contract

- Modify `templates/native-web/packages/product-sdk/src/manifest.ts`: make Stage definitions legacy-optional and add Stage-independent named intents/result component declarations.
- Modify `templates/native-web/product.manifest.json`: remove hard-coded navigation Stages and express only Workflow identity/capabilities/optional intents.
- Modify `workflows/native-web-qa/product.manifest.json` and `workflows/native-web-qa/native-web-qa.json`: return dynamic Stage Projections, names, memory updates, and historical results from the real QA Workflow.

### Web application

- Modify `templates/native-web/apps/web/src/domain/api.ts` and `src/commands/api.ts`: Stage-free workspace and unified Command clients.
- Create `templates/native-web/apps/web/src/memory/api.ts`: typed two-layer memory client.
- Modify `templates/native-web/apps/web/src/auth/storage.ts`: draft keys scoped to Context/Route/Conversation, including virtual Conversations and zero Context.
- Create `templates/native-web/apps/web/src/workspace/useWorkflowWorkspace.ts`: URL parsing, stale-request protection, bootstrap/current/history reconciliation, and virtual Conversation state.
- Create `templates/native-web/apps/web/src/workspace/ContextSidebar.tsx`: Context switching, secondary manual creation, and accessible rename.
- Create `templates/native-web/apps/web/src/workspace/ConversationSwitcher.tsx`: virtual/main/new Conversation switching, archive, and accessible rename.
- Modify `templates/native-web/apps/web/src/commands/ThreadConversation.tsx` and rename its exported component to `ConversationPane`: always-visible messages, Workflow feedback, interrupt mode, retries, attachments, and composer.
- Modify `templates/native-web/apps/web/src/workspace/ThreadDrawer.tsx` into a mobile/secondary `ConversationDrawer` rather than the primary input surface.
- Replace `templates/native-web/apps/web/src/stages/StageWorkspace.tsx` with `templates/native-web/apps/web/src/stages/StageProjectionPanel.tsx`: optional read-only density-adaptive renderer.
- Modify `templates/native-web/apps/web/src/workspace/VersionArchive.tsx`: full historical snapshot, warning, and direct Input that branches without a naming form.
- Replace `templates/native-web/apps/web/src/memory/ProposalPanel.tsx` with `templates/native-web/apps/web/src/memory/MemoryPanel.tsx`: user/context tabs, source/version/detail, revise, and invalidate.
- Modify `templates/native-web/apps/web/src/App.tsx`: compose the conversation-first shell only; domain orchestration moves to the hook/components above.
- Modify `templates/native-web/apps/web/src/styles.css`: desktop three-column and mobile one-scroll layouts, safe-area composer, 44px targets, drawers, focus, live status, and no horizontal overflow.

### Verification and documentation

- Modify the matching API/Web tests listed in each task; keep legacy data tests where backward compatibility is intentional.
- Modify `scripts/qa-native-release-governed.mjs` and `lib/native-web-qa-workflow.test.mjs`: production journey for zero Context, dynamic Stage counts, two-layer memory, rename, and historical branching.
- Modify `templates/native-web/README.md`: document the new domain/API contract and replace unmanaged service examples with governed startup instructions.
- Modify `polaris.json`: add this feature as `in-progress`, then `tested`, then `done` only with dated evidence.

---

### Task 1: Freeze the new domain contract in an additive migration

**Files:**
- Create: `templates/native-web/db/migrations/0005_core_input_memory.sql`
- Modify: `templates/native-web/apps/api/tests/migrate.integration.test.ts`
- Modify: `templates/native-web/apps/api/src/domain/types.ts`
- Test: `templates/native-web/apps/api/tests/migrate.integration.test.ts`

- [ ] **Step 1: Mark only this feature in progress and record the dirty baseline**

Add a new `R4.features[]` item in `polaris.json` without altering the existing completed Native Web QA item:

```json
{
  "name": "Native Workflow Web 核心输入与两层记忆重构",
  "description": "对话主轴、零 Context Start Command、动态只读 Stage Projection、用户/情景两层版本记忆",
  "status": "in-progress",
  "behavior": [
    "Workflow 是状态机权威，Web 不选择 Stage",
    "首条 Input 原子建立隐藏初始化范围并在成功后公开",
    "历史 Checkpoint Input 自动创建同等 Route",
    "Context/Conversation 重命名不触发 Workflow",
    "用户记忆跨 Context；情景记忆仅限当前 Context"
  ],
  "test_status": "not_tested",
  "evidence": [
    "docs/superpowers/specs/2026-07-17-native-workflow-web-core-input-design.md",
    "docs/superpowers/plans/2026-07-17-native-workflow-web-core-input.md"
  ]
}
```

Run: `git status --short && git diff -- polaris.json templates/native-web`

Expected: the known protected user changes remain present; no file is reset or newly staged.

- [ ] **Step 2: Write failing migration tests for the new invariants**

Extend `migrate.integration.test.ts` so a fresh schema proves:

```ts
expect(applied.rows.at(-1)).toMatchObject({ version: '0005_core_input_memory' });

await expect(insertConversation({ stageKey: null, titleSource: 'agent' })).resolves.toBeDefined();
await expect(insertCommand({ stageKey: null })).resolves.toBeDefined();
await expect(insertMemoryVersion({ scope: 'route' })).rejects.toMatchObject({ code: '23514' });
await expect(updateCheckpointSnapshot()).rejects.toMatchObject({ code: '55000' });
await expect(twoPrimaryConversationsForOneRoute()).rejects.toMatchObject({ code: '23505' });
```

Also assert old rows created by migrations 0002–0004 still load, while new public rows can use `initializing` status and nullable legacy `stage_key` columns.

- [ ] **Step 3: Run the migration test to verify RED**

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -w @polar/native-web-api -- tests/migrate.integration.test.ts`

Expected: FAIL because `0005_core_input_memory` and the new columns/tables/constraints do not exist. If `TEST_DATABASE_URL` is absent, use the governed QA database in Task 11; do not start a raw PostgreSQL container.

- [ ] **Step 4: Add the compatibility migration and canonical types**

The migration must preserve old data and implement these shapes:

```ts
export type PublicScopeStatus = 'initializing' | 'active' | 'archived';
export type TitleSource = 'agent' | 'user';

export interface StageProjectionSnapshot {
  revision: string;
  items: Array<{
    key: string;
    label: string;
    status: string;
    checkpointId?: string;
    summary?: string;
  }>;
}

export interface CheckpointSnapshot {
  workflowState: Record<string, unknown>;
  stageProjection?: StageProjectionSnapshot;
  memoryReferences: Array<{ memoryId: string; version: number }>;
  artifacts: CheckpointArtifact[];
}

export interface WorkflowConversation {
  id: string;
  contextId: string;
  routeId: string;
  title: string;
  titleSource: TitleSource;
  isPrimary: boolean;
  status: PublicScopeStatus;
  createdAt: Date;
  updatedAt: Date;
}
```

SQL responsibilities in `0005_core_input_memory.sql`:

```sql
ALTER TABLE contexts ADD COLUMN title_source text NOT NULL DEFAULT 'user';
ALTER TABLE workflow_routes ADD COLUMN status text NOT NULL DEFAULT 'active';
ALTER TABLE workflow_threads ADD COLUMN title_source text NOT NULL DEFAULT 'user';
ALTER TABLE workflow_threads ADD COLUMN is_primary boolean NOT NULL DEFAULT false;
ALTER TABLE workflow_threads ALTER COLUMN stage_key DROP NOT NULL;

CREATE UNIQUE INDEX workflow_threads_one_primary_per_route
  ON workflow_threads(route_id) WHERE is_primary AND status <> 'archived';

CREATE TABLE memory_items (... scope text NOT NULL, context_id uuid, status text NOT NULL, ...);
CREATE TABLE memory_item_versions (... source jsonb NOT NULL, evidence jsonb NOT NULL,
  impact_scope jsonb NOT NULL, version integer NOT NULL, value jsonb, ...);
CREATE TABLE staged_attachments (... user_id uuid NOT NULL, object_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending', adopted_command_id uuid, ...);
```

Drop and recreate only the Stage-bearing foreign keys from migrations 0002–0004 so ownership is enforced by `(id, context_id, route_id)` rather than `(id, context_id, route_id, stage_key)`. Keep legacy `stage_key` columns nullable for release compatibility, but no new public API may require them. Restrict memory scopes to exactly `user` and `context`; version rows are append-only; invalidation is a new version with status `invalidated`, never a delete.

- [ ] **Step 5: Run migration and type verification**

Run: `npm run build -w @polar/native-web-api`

Expected: PASS.

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -w @polar/native-web-api -- tests/migrate.integration.test.ts`

Expected: PASS when the governed test database is available.

- [ ] **Step 6: Commit the isolated schema contract**

Run:

```bash
git add -p -- polaris.json templates/native-web/db/migrations/0005_core_input_memory.sql templates/native-web/apps/api/src/domain/types.ts templates/native-web/apps/api/tests/migrate.integration.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat(native-web): add core input domain migration"
```

Expected: only Task 1 hunks are staged; protected pre-existing hunks remain unstaged.

---

### Task 2: Make Context, Route, Conversation, rename, and history Stage-independent

**Files:**
- Modify: `templates/native-web/apps/api/src/domain/repository.ts`
- Modify: `templates/native-web/apps/api/src/domain/service.ts`
- Modify: `templates/native-web/apps/api/src/routes/domain.ts`
- Modify: `templates/native-web/apps/api/tests/domain-service.test.ts`
- Modify: `templates/native-web/apps/api/tests/domain-repository.integration.test.ts`
- Modify: `templates/native-web/apps/api/tests/domain-routes.integration.test.ts`
- Modify: `templates/native-web/apps/web/src/domain/api.ts`
- Modify: `templates/native-web/apps/web/src/domain/api.test.ts`

- [ ] **Step 1: Write failing service and route tests**

Replace Stage-selected workspace expectations with:

```ts
expect(await service.getRouteWorkspace(userId, routeId, {})).toMatchObject({
  route: { id: routeId },
  conversations: expect.any(Array),
  headCheckpoint: expect.objectContaining({ id: headCheckpointId }),
});

await service.renameContext(userId, contextId, { title: '新名称' });
await service.renameConversation(userId, conversationId, { title: '新讨论' });
expect(repository.runWorkflow).not.toHaveBeenCalled();
expect(repository.branchRoute).not.toHaveBeenCalled();
```

Route tests must cover:

```text
GET   /api/routes/:routeId/workspace?checkpoint=<optional uuid>
PATCH /api/contexts/:contextId           { title }
POST  /api/routes/:routeId/conversations {}
PATCH /api/conversations/:conversationId { title?, status? }
```

`POST /conversations` creates a title-source `agent`, initializing/virtual-compatible Conversation with no title input and no `stageKey`. Context and Conversation PATCH set `title_source='user'`, permit duplicate titles, and do not write Checkpoints, Commands, memories, or Routes.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npm test -w @polar/native-web-api -- tests/domain-service.test.ts tests/domain-routes.integration.test.ts`

Expected: FAIL on the old `stage` query, required titles, missing Context PATCH, and Stage-scoped repository signatures.

- [ ] **Step 3: Implement minimal Stage-free domain reads and metadata mutations**

Use these service signatures:

```ts
getRouteWorkspace(userId: string, routeId: string, input: { checkpointId?: string }): Promise<RouteWorkspace>;
createConversation(userId: string, routeId: string): Promise<WorkflowConversation>;
renameContext(userId: string, contextId: string, input: { title: string }): Promise<WorkflowContext>;
updateConversation(
  userId: string,
  conversationId: string,
  input: { title?: string; status?: 'active' | 'archived' },
): Promise<WorkflowConversation>;
```

`getRouteWorkspace` returns active Conversations across the Route, the immutable selected Checkpoint, `isHistorical`, the head Checkpoint, artifacts, and the selected Checkpoint's own optional `stageProjection`. It must not validate against `manifest.stages`, and merely viewing a historical Checkpoint performs no write.

- [ ] **Step 4: Update the browser domain client**

Expose:

```ts
export const getRouteWorkspace = (routeId: string, checkpointId?: string) =>
  request<RouteWorkspace>(`/api/routes/${encodeURIComponent(routeId)}/workspace${checkpointId ? `?checkpoint=${encodeURIComponent(checkpointId)}` : ''}`);

export const createConversation = (routeId: string) =>
  request<WorkflowConversation>(`/api/routes/${encodeURIComponent(routeId)}/conversations`, {
    method: 'POST', body: '{}',
  });
```

Delete `selectedStageKey`, `StageProjection.componentKey`, and required `stageKey/title` arguments from the public client types.

- [ ] **Step 5: Run focused and regression tests**

Run: `npm test -w @polar/native-web-api -- tests/domain-service.test.ts tests/domain-repository.integration.test.ts tests/domain-routes.integration.test.ts`

Expected: PASS with the governed integration database; unit tests pass regardless.

Run: `npm test -w @polar/native-web-web -- src/domain/api.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit only Task 2 hunks**

Run: `git add -p -- templates/native-web/apps/api/src/domain templates/native-web/apps/api/src/routes/domain.ts templates/native-web/apps/api/tests/domain-* templates/native-web/apps/web/src/domain && git diff --cached && git commit -m "refactor(native-web): decouple conversations from stages"`

Expected: no unrelated auth/assets/style hunks are included.

---

### Task 3: Introduce one unified Start/current/history Command

**Files:**
- Modify: `templates/native-web/apps/api/src/commands/types.ts`
- Modify: `templates/native-web/apps/api/src/commands/repository.ts`
- Modify: `templates/native-web/apps/api/src/commands/service.ts`
- Modify: `templates/native-web/apps/api/src/routes/commands.ts`
- Modify: `templates/native-web/apps/api/src/app.ts`
- Modify: `templates/native-web/apps/api/tests/command-service.test.ts`
- Modify: `templates/native-web/apps/api/tests/command-repository.integration.test.ts`
- Modify: `templates/native-web/apps/api/tests/command-routes.integration.test.ts`

- [ ] **Step 1: Write failing tests for all three scope modes**

The public request uses one endpoint and never contains `stageKey`:

```ts
type PublicCommandInput = {
  commandId: string;
  contextId?: string;
  routeId?: string;
  conversationId?: string;
  baseCheckpointId?: string;
  expectedCheckpointVersion?: number;
  input:
    | { type: 'message'; content: string }
    | { type: 'named_intent'; key: string; content?: string }
    | { type: 'resume_interrupt'; interruptId: string; content: string };
  attachmentIds: string[];
};
```

Tests must prove:

- all five scope fields absent means Start Command;
- existing Context/Route/Checkpoint with no Conversation materializes a primary Conversation on success;
- a head Checkpoint appends one new Checkpoint on the same Route;
- a non-head `baseCheckpointId` creates a new equal Route plus a new Conversation and leaves the source Route unchanged;
- Start/branch failures expose no active empty Context, Route, or Conversation;
- exact command replay is idempotent; changed payload with the same command ID is rejected;
- expected-version conflict refreshes to the current Route head;
- every successful message, named intent, or interrupt creates/records the returned Checkpoint;
- rename APIs are never invoked by Command finalization when `titleSource='user'`.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npm test -w @polar/native-web-api -- tests/command-service.test.ts tests/command-routes.integration.test.ts`

Expected: FAIL because commands are still posted under a required Thread and reject non-head Checkpoints.

- [ ] **Step 3: Define the repository state machine**

Implement `prepareCommand` and `finalizeCommand` around this discriminated execution target:

```ts
export type CommandScope =
  | { mode: 'start'; provisionalContextId: string; provisionalRouteId: string; provisionalConversationId: string }
  | { mode: 'head'; contextId: string; routeId: string; conversationId: string | null }
  | { mode: 'history'; contextId: string; sourceRouteId: string; sourceCheckpointId: string };
```

Rules:

1. Start creates `initializing` Context/Route/primary Conversation plus bootstrap Checkpoint version 0 in the claim transaction. `listContexts` and normal workspaces exclude `initializing` rows.
2. Head with no Conversation creates an `initializing` primary Conversation; it becomes active only after success.
3. History runs from the selected immutable snapshot. Finalization atomically creates an active Route with `origin_checkpoint_id`, a branch bootstrap Checkpoint, a new active primary Conversation, the user/assistant messages, and the Workflow result Checkpoint. It does not ask for a Route name.
4. Successful Start/head finalization applies agent titles only where `title_source='agent'`, activates provisional rows, appends the Workflow result Checkpoint, writes messages/events, and advances the Route head in one transaction.
5. Failed initialization remains hidden and retryable/auditable; it never appears in `/api/contexts`.
6. Plain history reads perform no `INSERT` or `UPDATE`.

- [ ] **Step 4: Replace the public route and preserve SSE durability**

Register:

```text
POST /api/workflow/commands
GET  /api/conversations/:conversationId/messages
GET  /api/commands/:commandId/events
```

Keep `202 { commandId, eventUrl }`, durable execution after the POST returns, replay through `Last-Event-ID`, heartbeat comments, anti-buffering headers, safe error codes, and per-user rate limiting. Retain old `/api/threads/:threadId/commands` only as an explicitly tested compatibility adapter during this release; the new Web must not call it.

- [ ] **Step 5: Run repository, route, and migration tests**

Run: `npm test -w @polar/native-web-api -- tests/command-service.test.ts tests/command-routes.integration.test.ts`

Expected: PASS.

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -w @polar/native-web-api -- tests/command-repository.integration.test.ts tests/domain-repository.integration.test.ts tests/migrate.integration.test.ts`

Expected: PASS with no visible empty scope after injected failure and no source Route mutation after history input.

- [ ] **Step 6: Commit the unified Command transaction**

Run: `git add -p -- templates/native-web/apps/api/src/commands templates/native-web/apps/api/src/routes/commands.ts templates/native-web/apps/api/src/app.ts templates/native-web/apps/api/tests/command-* && git diff --cached && git commit -m "feat(native-web): add unified workflow input command"`

Expected: only Command/API wiring hunks are committed.

---

### Task 4: Make the Workflow Bridge own FSM progression and dynamic Stage Projection

**Files:**
- Modify: `templates/native-web/apps/api/src/commands/bridge.ts`
- Modify: `templates/native-web/apps/api/src/commands/service.ts`
- Modify: `templates/native-web/apps/api/tests/workflow-bridge.test.ts`
- Modify: `templates/native-web/apps/api/tests/command-service.test.ts`
- Modify: `templates/native-web/packages/product-sdk/src/manifest.ts`
- Modify: `templates/native-web/packages/product-sdk/tests/manifest.test.ts`
- Modify: `templates/native-web/product.manifest.json`

- [ ] **Step 1: Write failing Bridge and manifest tests**

Test a normal message that returns a changed projection, proving FSM movement is legal without a named action:

```ts
expect(result.stageProjection).toEqual({
  revision: 'workflow-v7',
  items: [
    { key: 'understand', label: '理解问题', status: 'completed', checkpointId: checkpointId },
    { key: 'deliver', label: '交付', status: 'active', summary: '正在生成结果' },
  ],
});
expect(upstreamBody.input).not.toHaveProperty('stage_key');
expect(upstreamBody).not.toHaveProperty('setStage');
```

Cover 0, 1, 2–6, and 7+ projection items, duplicate keys, missing labels, arbitrary Workflow-defined status strings, old projection revisions, named intents independent of Stage, and sanitized diagnostics. Manifest tests must accept no `stages`, accept optional top-level `intents`, and continue parsing legacy manifests.

- [ ] **Step 2: Run Bridge tests to verify RED**

Run: `npm test -w @polar/native-web-api -- tests/workflow-bridge.test.ts`

Expected: FAIL because messages currently reject Stage signals and the Bridge constructs `stage_key`/manifest Stage payloads.

- [ ] **Step 3: Implement the versioned Bridge request/response contract**

Send:

```ts
{
  contract_version: '2.0',
  command: {
    id: input.commandId,
    context_id: input.contextId,
    route_id: input.routeId,
    conversation_id: input.conversationId,
    base_checkpoint_id: input.baseCheckpoint.id,
    expected_checkpoint_version: input.baseCheckpoint.version,
    input: input.commandInput,
    attachments: input.attachments,
  },
  history: input.history,
  memory: input.memory,
  checkpoint_snapshot: input.baseCheckpoint.snapshot,
  workflow_id: options.workflowId,
}
```

Normalize this result:

```ts
interface WorkflowBridgeResult {
  replyEvents: Array<{ type: 'delta' | 'message'; content: string }>;
  checkpoint: { workflowState: Record<string, unknown> };
  stageProjection?: StageProjectionSnapshot;
  contextTitle?: string;
  conversationTitle?: string;
  memoryUpdates: MemoryUpdate[];
  artifactProposals: ArtifactProposal[];
  interrupt: { prompt: string; cursor: unknown } | null;
  diagnostics: Record<string, unknown>;
}
```

Do not compare projection items with Manifest Stage definitions and do not require monotonic Web-known statuses. Validate only bounded strings, unique keys, item count, optional checkpoint UUIDs, response byte limits, artifact safety, and public diagnostic allowlists.

- [ ] **Step 4: Run package, Bridge, and service tests**

Run: `npm test -w @polar/native-web-product-sdk`

Expected: PASS for current and legacy manifests.

Run: `npm test -w @polar/native-web-api -- tests/workflow-bridge.test.ts tests/command-service.test.ts`

Expected: PASS; a plain message can advance the Workflow projection.

- [ ] **Step 5: Commit the Workflow-owned projection contract**

Run: `git add -p -- templates/native-web/apps/api/src/commands/bridge.ts templates/native-web/apps/api/src/commands/service.ts templates/native-web/apps/api/tests/workflow-bridge.test.ts templates/native-web/apps/api/tests/command-service.test.ts templates/native-web/packages/product-sdk templates/native-web/product.manifest.json && git diff --cached && git commit -m "refactor(native-web): make stage projection workflow-owned"`

Expected: no compile/export script changes are included.

---

### Task 5: Implement exactly two public memory layers with append-only versions

**Files:**
- Create: `templates/native-web/apps/api/src/memory/types.ts`
- Create: `templates/native-web/apps/api/src/memory/service.ts`
- Modify: `templates/native-web/apps/api/src/memory/repository.ts`
- Modify: `templates/native-web/apps/api/src/routes/memory.ts`
- Modify: `templates/native-web/apps/api/src/app.ts`
- Modify: `templates/native-web/apps/api/src/server.ts`
- Create: `templates/native-web/apps/api/tests/memory-service.test.ts`
- Create: `templates/native-web/apps/api/tests/memory-repository.integration.test.ts`
- Modify: `templates/native-web/apps/api/tests/phase5-routes.test.ts`
- Modify: `templates/native-web/apps/api/src/commands/bridge.ts`
- Modify: `templates/native-web/apps/api/tests/workflow-bridge.test.ts`

- [ ] **Step 1: Write failing memory domain tests**

Use this public model:

```ts
export interface MemoryItem {
  id: string;
  scope: 'user' | 'context';
  contextId: string | null;
  key: string;
  value: unknown;
  status: 'active' | 'invalidated';
  version: number;
  source: { kind: 'workflow' | 'user'; commandId?: string; conversationId?: string };
  evidence: Array<{ kind: string; id: string; excerpt?: string }>;
  impactScope: { contextIds: string[] | 'all' };
  createdAt: Date;
  updatedAt: Date;
}
```

Tests must prove user memory appears across Contexts, context memory appears only in its Context, revisions append version N+1, invalidation appends an auditable tombstone, old versions remain readable, cross-user access is hidden, and `route/stage/thread` scopes are rejected.

- [ ] **Step 2: Add failing extraction-policy and conflict tests**

The Bridge request must carry two distinct literal goals:

```ts
const USER_MEMORY_GOAL = '是对用户的建模，能揭示用户的习惯、特点、taste。';
const CONTEXT_MEMORY_GOAL = '是对本情景的建模，是本情景的本质信息；对之后处理具体问题有持续性帮助或约束。';
```

Test that an update to an active key requires `expectedVersion`; a mismatched version or an update marked `highImpact` creates a pending Workflow Interrupt and never overwrites the active memory silently.

- [ ] **Step 3: Run tests to verify RED**

Run: `npm test -w @polar/native-web-api -- tests/memory-service.test.ts tests/phase5-routes.test.ts tests/workflow-bridge.test.ts`

Expected: FAIL because only five-scope proposals/decisions exist.

- [ ] **Step 4: Implement repository/service/version APIs**

Register:

```text
GET    /api/memory?scope=user
GET    /api/memory?scope=context&context=<uuid>
GET    /api/memory/:memoryId/versions
PATCH  /api/memory/:memoryId       { value, expectedVersion, evidence? }
DELETE /api/memory/:memoryId       { expectedVersion, reason }
```

PATCH and DELETE are direct metadata operations; they do not create Workflow Commands, Routes, Checkpoints, or branches. The repository locks one `memory_items` row, verifies ownership and expected version, appends a `memory_item_versions` row, and updates only the item's current status/version pointer. Command finalization automatically applies non-conflicting Workflow updates and stores source Command/Conversation/Checkpoint metadata.

- [ ] **Step 5: Implement the conflict-to-Interrupt boundary**

Before finalizing memory updates:

```ts
const conflict = await memoryRepository.detectConflict(update);
if (conflict || update.highImpact) {
  return commandRepository.persistInterrupt({
    prompt: update.confirmationPrompt,
    cursor: { kind: 'memory_confirmation', update, current: conflict?.current },
  });
}
await memoryRepository.appendWorkflowVersion(update);
```

Resume goes back through the Workflow Bridge using only the private cursor stored in PostgreSQL. No conflicting value is activated until the resumed Workflow returns a confirmed update with the current expected version.

- [ ] **Step 6: Run memory and Command regressions**

Run: `npm test -w @polar/native-web-api -- tests/memory-service.test.ts tests/workflow-bridge.test.ts tests/command-service.test.ts tests/phase5-routes.test.ts`

Expected: PASS.

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -w @polar/native-web-api -- tests/memory-repository.integration.test.ts tests/command-repository.integration.test.ts`

Expected: PASS with append-only history and conflict serialization.

- [ ] **Step 7: Commit two-layer memory**

Run: `git add -p -- templates/native-web/apps/api/src/memory templates/native-web/apps/api/src/routes/memory.ts templates/native-web/apps/api/src/app.ts templates/native-web/apps/api/src/server.ts templates/native-web/apps/api/src/commands/bridge.ts templates/native-web/apps/api/tests/memory-* templates/native-web/apps/api/tests/phase5-routes.test.ts templates/native-web/apps/api/tests/workflow-bridge.test.ts && git diff --cached && git commit -m "feat(native-web): add two-layer versioned memory"`

Expected: only memory/Bridge wiring hunks are staged.

---

### Task 6: Stage attachments before a Context or Conversation exists

**Files:**
- Modify: `templates/native-web/apps/api/src/assets/repository.ts`
- Modify: `templates/native-web/apps/api/src/assets/service.ts`
- Modify: `templates/native-web/apps/api/src/routes/assets.ts`
- Modify: `templates/native-web/apps/api/tests/asset-service.test.ts`
- Modify: `templates/native-web/apps/api/tests/phase5-routes.test.ts`
- Modify: `templates/native-web/apps/api/src/commands/repository.ts`
- Modify: `templates/native-web/apps/api/tests/command-repository.integration.test.ts`
- Modify: `templates/native-web/apps/web/src/assets/api.ts`
- Modify: `templates/native-web/apps/web/src/assets/AttachmentPanel.tsx`
- Modify: `templates/native-web/apps/web/src/assets/AttachmentPanel.test.tsx`

- [ ] **Step 1: Write failing staged-upload tests**

Tests must cover upload with no Context/Conversation, command ownership, retry reuse after Workflow failure, successful one-time adoption into the result Conversation, cross-user hiding, and no user-visible empty scope.

```ts
const staged = await service.stageAttachment(userId, { filename, mediaType, body });
expect(staged).toMatchObject({ status: 'pending', conversationId: null });

await repository.adoptStagedAttachments(commandId, conversationId, [staged.id]);
expect(await service.listConversationAttachments(userId, conversationId)).toHaveLength(1);
```

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npm test -w @polar/native-web-api -- tests/asset-service.test.ts tests/phase5-routes.test.ts`

Expected: FAIL because upload currently requires a Thread.

- [ ] **Step 3: Add user-owned staging and transactional adoption**

Register:

```text
POST   /api/attachments/staged
DELETE /api/attachments/staged/:attachmentId
GET    /api/conversations/:conversationId/attachments
```

Keep 25 MB, SHA-256 deduplication, safe filename/media type, owned download, and `nosniff`. `POST /api/workflow/commands` receives only opaque staged attachment IDs. Claim validates ownership; finalization adopts them in the same transaction as messages/Checkpoint; failure leaves them pending so the retained draft can retry.

- [ ] **Step 4: Update the Web attachment client and panel**

`AttachmentPanel` accepts `{ staged, onChange, conversationId? }`; it can upload before a Context exists, lists adopted items after success, and never clears staged IDs on a failed command.

- [ ] **Step 5: Run API and Web tests**

Run: `npm test -w @polar/native-web-api -- tests/asset-service.test.ts tests/phase5-routes.test.ts`

Expected: PASS.

Run: `npm test -w @polar/native-web-web -- src/assets/AttachmentPanel.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit staged attachments**

Run: `git add -p -- templates/native-web/apps/api/src/assets templates/native-web/apps/api/src/routes/assets.ts templates/native-web/apps/api/src/commands/repository.ts templates/native-web/apps/api/tests/asset-service.test.ts templates/native-web/apps/api/tests/phase5-routes.test.ts templates/native-web/apps/api/tests/command-repository.integration.test.ts templates/native-web/apps/web/src/assets && git diff --cached && git commit -m "feat(native-web): stage attachments before workflow input"`

Expected: no unrelated existing asset redesign hunk is committed.

---

### Task 7: Replace Stage URLs and Thread commands in the Web state layer

**Files:**
- Modify: `templates/native-web/apps/web/src/domain/api.ts`
- Modify: `templates/native-web/apps/web/src/commands/api.ts`
- Modify: `templates/native-web/apps/web/src/domain/api.test.ts`
- Modify: `templates/native-web/apps/web/src/commands/api.test.ts`
- Modify: `templates/native-web/apps/web/src/auth/storage.ts`
- Modify: `templates/native-web/apps/web/src/auth/storage.test.ts`
- Create: `templates/native-web/apps/web/src/workspace/useWorkflowWorkspace.ts`
- Create: `templates/native-web/apps/web/src/workspace/useWorkflowWorkspace.test.tsx`

- [ ] **Step 1: Write failing URL, draft, and client tests**

Canonical locations are:

```text
/
/contexts/:contextId/routes/:routeId
/contexts/:contextId/routes/:routeId/conversations/:conversationId
?checkpoint=:checkpointId
```

No canonical URL contains `/stages/` or `stage=`. Tests must prove deep-link replacement for inaccessible IDs, back/forward navigation, stale request protection, virtual Conversation selection, zero-Context draft restoration, per-Conversation draft isolation, history selection, and preservation of input/attachment IDs after command failure.

- [ ] **Step 2: Run focused Web tests to verify RED**

Run: `npm test -w @polar/native-web-web -- src/domain/api.test.ts src/commands/api.test.ts src/auth/storage.test.ts`

Expected: FAIL on Thread URLs, Stage query fields, and Stage-bearing draft keys.

- [ ] **Step 3: Implement typed clients and workspace reducer/hook**

The hook owns:

```ts
interface WorkspaceSelection {
  contextId?: string;
  routeId?: string;
  conversationId?: string;
  checkpointId?: string;
  virtualConversationId?: string;
}

type WorkspacePhase =
  | 'loading'
  | 'empty'
  | 'ready'
  | 'initializing'
  | 'error';
```

It loads Contexts, selects the most recent active Context/Route, preserves the newest navigation generation, exposes a virtual primary Conversation when none exists, creates a local empty virtual Conversation immediately on `+`, and reconciles IDs from the terminal Command event. It never selects or mutates Stage state.

- [ ] **Step 4: Implement unified Command client**

```ts
export async function createWorkflowCommand(input: PublicCommandInput, options: RequestOptions = {}) {
  return requestReceipt('/api/workflow/commands', input, options);
}

export async function listConversationMessages(conversationId: string, options: RequestOptions = {}) {
  return requestMessages(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, options);
}
```

Keep SSE frame parsing/reconnect behavior unchanged except terminal payload now contains Context/Route/Conversation/Checkpoint IDs and optional Stage Projection revision, never `stageKey`.

- [ ] **Step 5: Run Web state tests**

Run: `npm test -w @polar/native-web-web -- src/domain/api.test.ts src/commands/api.test.ts src/auth/storage.test.ts src/workspace/useWorkflowWorkspace.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the Stage-free Web state layer**

Run: `git add -p -- templates/native-web/apps/web/src/domain templates/native-web/apps/web/src/commands/api.ts templates/native-web/apps/web/src/commands/api.test.ts templates/native-web/apps/web/src/auth/storage.ts templates/native-web/apps/web/src/auth/storage.test.ts templates/native-web/apps/web/src/workspace/useWorkflowWorkspace* && git diff --cached && git commit -m "refactor(native-web): add conversation-first workspace state"`

Expected: no App/styles/component hunks are staged yet.

---

### Task 8: Make Conversation and Composer the permanent interaction axis

**Files:**
- Modify: `templates/native-web/apps/web/src/commands/ThreadConversation.tsx`
- Modify: `templates/native-web/apps/web/src/commands/ThreadConversation.test.tsx`
- Create: `templates/native-web/apps/web/src/workspace/ContextSidebar.tsx`
- Create: `templates/native-web/apps/web/src/workspace/ContextSidebar.test.tsx`
- Create: `templates/native-web/apps/web/src/workspace/ConversationSwitcher.tsx`
- Create: `templates/native-web/apps/web/src/workspace/ConversationSwitcher.test.tsx`
- Modify: `templates/native-web/apps/web/src/workspace/ThreadDrawer.tsx`
- Modify: `templates/native-web/apps/web/src/workspace/ThreadDrawer.test.tsx`
- Modify: `templates/native-web/apps/web/src/App.tsx`
- Modify: `templates/native-web/apps/web/src/App.test.tsx`

- [ ] **Step 1: Replace old App tests with the confirmed first-use contract**

Write failing tests asserting:

```ts
expect(await screen.findByRole('textbox', { name: 'Workflow Input' })).toBeEnabled();
expect(screen.queryByRole('button', { name: /创建第一个/ })).not.toBeInTheDocument();
expect(screen.queryByLabelText(/名称/)).not.toBeInTheDocument();
```

Cover zero Context Start, initialization status `正在理解并建立工作情景`, failure retry with exact draft/attachments, existing Context with no Conversation, immediate untitled virtual Conversation from `+`, shared memory but isolated drafts/history, manual rename lock, Escape cancel, Enter save, focus restoration, archive, interrupts, errors adjacent to triggering Input, live execution states, and no Stage navigation or `setStage` control.

- [ ] **Step 2: Run component tests to verify RED**

Run: `npm test -w @polar/native-web-web -- src/App.test.tsx src/commands/ThreadConversation.test.tsx src/workspace/ThreadDrawer.test.tsx`

Expected: FAIL because Composer is hidden in a Stage discussion drawer and first use requires names.

- [ ] **Step 3: Refactor `ThreadConversation` into `ConversationPane`**

Keep the file for a low-conflict transition, but export:

```tsx
export function ConversationPane(props: {
  selection: WorkspaceSelection;
  conversation?: WorkflowConversation;
  checkpoint?: WorkflowCheckpoint;
  intents: NamedIntent[];
  stagedAttachments: StagedAttachment[];
  onCommandFinished(result: CommandFinishedPayload): void;
}) { /* persistent timeline, feedback, interrupt, composer */ }
```

The composer is rendered for empty/virtual/current/history modes. In history mode show the exact warning from the spec and submit the selected `baseCheckpointId`; the server decides to branch. Named intents are secondary shortcuts and never Stage controls. Keep command IDs stable per attempt; retry reuses the retained content and attachment IDs.

- [ ] **Step 4: Implement accessible Context and Conversation management**

`ContextSidebar` provides switch, secondary manual creation/import entry, and rename. `ConversationSwitcher` shows name, activity, Route, status, plus `+`, rename/info/archive. Inline rename uses a local draft, Enter save, Escape cancel, and restores focus to the menu trigger. New Conversations do not ask for a title.

- [ ] **Step 5: Recompose `App.tsx`**

`App.tsx` should contain only ProductBar plus the state hook and shell composition:

```tsx
<ContextSidebar />
<main className="conversation-axis">
  <WorkspaceHeader />
  <ConversationSwitcher />
  <ConversationPane />
</main>
<WorkspaceInspector />
```

Delete the Stage navigator, Stage workspace primary card, first-Context naming gate, and primary Thread drawer trigger. Keep the drawer only for compact Conversation management on mobile.

- [ ] **Step 6: Run all interaction tests**

Run: `npm test -w @polar/native-web-web -- src/App.test.tsx src/commands/ThreadConversation.test.tsx src/workspace/ContextSidebar.test.tsx src/workspace/ConversationSwitcher.test.tsx src/workspace/ThreadDrawer.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit the conversation-first shell**

Run: `git add -p -- templates/native-web/apps/web/src/App.tsx templates/native-web/apps/web/src/App.test.tsx templates/native-web/apps/web/src/commands/ThreadConversation* templates/native-web/apps/web/src/workspace/ContextSidebar* templates/native-web/apps/web/src/workspace/ConversationSwitcher* templates/native-web/apps/web/src/workspace/ThreadDrawer* && git diff --cached && git commit -m "feat(native-web): make workflow input always available"`

Expected: protected existing workspace component hunks are reviewed individually.

---

### Task 9: Add the two-layer memory inspector and read-only dynamic Stage Projection

**Files:**
- Create: `templates/native-web/apps/web/src/memory/api.ts`
- Create: `templates/native-web/apps/web/src/memory/api.test.ts`
- Create: `templates/native-web/apps/web/src/memory/MemoryPanel.tsx`
- Create: `templates/native-web/apps/web/src/memory/MemoryPanel.test.tsx`
- Delete after replacement: `templates/native-web/apps/web/src/memory/ProposalPanel.tsx`
- Create: `templates/native-web/apps/web/src/stages/StageProjectionPanel.tsx`
- Create: `templates/native-web/apps/web/src/stages/StageProjectionPanel.test.tsx`
- Delete after replacement: `templates/native-web/apps/web/src/stages/StageWorkspace.tsx`
- Replace: `templates/native-web/apps/web/src/stages/StageWorkspace.test.tsx`
- Modify: `templates/native-web/apps/web/src/App.tsx`
- Modify: `templates/native-web/apps/web/src/App.test.tsx`

- [ ] **Step 1: Write failing memory UI tests**

Tests must show user/context tabs, scope explanation, value, status, source, created/updated time, version, impact, evidence, full version history, revise, invalidate, expected-version conflicts, and Workflow interrupt cards for high-impact/conflicting updates. User memory survives Context switching; context memory changes with Context.

- [ ] **Step 2: Write failing Stage density tests**

Assert:

```ts
expect(renderProjection([])).not.toContain('阶段');
expect(renderProjection([one])).toHaveSingleStatusBlock();
expect(renderProjection(six)).toHaveVisibleItems(6);
expect(renderProjection(seven)).toShowSummaryAndDrawerTrigger();
```

Clicking an item with `checkpointId` opens that exact read-only Checkpoint. Items without one are non-navigation status. The component receives no Manifest Stage list, no actions, and no mutation callback.

- [ ] **Step 3: Run focused tests to verify RED**

Run: `npm test -w @polar/native-web-web -- src/memory/MemoryPanel.test.tsx src/stages/StageProjectionPanel.test.tsx`

Expected: FAIL because these components do not exist and the old panel only lists Thread proposals.

- [ ] **Step 4: Implement MemoryPanel and StageProjectionPanel**

`MemoryPanel` calls the typed memory endpoints and renders edit/invalidate dialogs without Workflow Commands. `StageProjectionPanel` reads the selected Checkpoint's snapshot, uses neutral status text/classes for unknown Workflow statuses, hides at zero items, and opens a vertical drawer for 7+ items.

- [ ] **Step 5: Integrate into the desktop inspector/mobile drawer**

The right-side inspector has tabs `情景记忆 / 用户记忆 / 成果 / 运行`; Stage Projection appears only under `运行`. On mobile the same inspector is a full-screen layer. Artifact cards still appear in the Conversation causal chain and synchronize to `成果`.

- [ ] **Step 6: Run focused and App tests**

Run: `npm test -w @polar/native-web-web -- src/memory src/stages src/App.test.tsx`

Expected: PASS for dynamic counts, memory version actions, and no Stage-first layout.

- [ ] **Step 7: Commit memory and projection UI**

Run: `git add -p -- templates/native-web/apps/web/src/memory templates/native-web/apps/web/src/stages templates/native-web/apps/web/src/App.tsx templates/native-web/apps/web/src/App.test.tsx && git diff --cached && git commit -m "feat(native-web): add memory and stage projection inspector"`

Expected: deleted legacy files and new replacements are the only staged UI paths.

---

### Task 10: Make Checkpoint history read-only and branch only through Input

**Files:**
- Modify: `templates/native-web/apps/web/src/workspace/VersionArchive.tsx`
- Modify: `templates/native-web/apps/web/src/workspace/VersionArchive.test.tsx`
- Modify: `templates/native-web/apps/web/src/App.tsx`
- Modify: `templates/native-web/apps/web/src/App.test.tsx`
- Modify: `templates/native-web/apps/api/tests/domain-repository.integration.test.ts`
- Modify: `templates/native-web/apps/api/tests/command-repository.integration.test.ts`

- [ ] **Step 1: Write failing history tests**

Tests must prove viewing projections/memory/artifacts, downloading/copying artifacts, renaming Context/Conversation, closing history, and returning to current create no Route or Checkpoint. The only branch trigger is submitting Input while a non-head Checkpoint is selected.

The history warning is exact:

```text
正在查看历史投影。此版本不可修改；从这里输入会创建一条新时间线，原路线不受影响。
```

The branch flow has no Route/Conversation naming form. After success it navigates to the new equal Route/Conversation and displays source Checkpoint provenance.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npm test -w @polar/native-web-web -- src/workspace/VersionArchive.test.tsx src/App.test.tsx`

Expected: FAIL because the old archive branches through an explicit named Route form.

- [ ] **Step 3: Replace explicit branch creation with history selection**

`VersionArchive` becomes a read-only browser with `onSelectCheckpoint(checkpointId)` and no `onCreateRoute`. It renders snapshot Stage Projection, memory references, artifacts, Workflow revision, parent/source Command, and a `在此版本继续` action that selects the Checkpoint and focuses the always-visible composer. The next Input sends the historical base Checkpoint; the unified Command transaction creates the Route.

- [ ] **Step 4: Re-run Web and PostgreSQL history tests**

Run: `npm test -w @polar/native-web-web -- src/workspace/VersionArchive.test.tsx src/App.test.tsx`

Expected: PASS.

Run: `TEST_DATABASE_URL="$TEST_DATABASE_URL" npm test -w @polar/native-web-api -- tests/domain-repository.integration.test.ts tests/command-repository.integration.test.ts`

Expected: PASS; browse/rename paths have zero branch writes, historical Input has exactly one new Route, and the source is unchanged.

- [ ] **Step 5: Commit history behavior**

Run: `git add -p -- templates/native-web/apps/web/src/workspace/VersionArchive* templates/native-web/apps/web/src/App* templates/native-web/apps/api/tests/domain-repository.integration.test.ts templates/native-web/apps/api/tests/command-repository.integration.test.ts && git diff --cached && git commit -m "refactor(native-web): branch only from historical input"`

Expected: no unrelated App test rewrites are staged.

---

### Task 11: Finish responsive accessibility, documentation, and governed production verification

**Files:**
- Modify: `templates/native-web/apps/web/src/styles.css`
- Modify: `templates/native-web/apps/web/src/App.test.tsx`
- Modify: `templates/native-web/apps/web/src/commands/ThreadConversation.test.tsx`
- Modify: `templates/native-web/README.md`
- Modify: `workflows/native-web-qa/native-web-qa.json`
- Modify: `workflows/native-web-qa/product.manifest.json`
- Modify: `lib/native-web-qa-workflow.test.mjs`
- Modify: `scripts/qa-native-release-governed.mjs`
- Modify: `polaris.json`

- [ ] **Step 1: Write failing accessibility/layout assertions**

Component tests must cover status/error/completion live regions, dialog labels, Escape close, rename focus restoration, DOM order matching visual order, and no disabled composer outside an Interrupt. Add CSS contract assertions or production browser checks for:

```css
min-inline-size: 44px;
min-block-size: 44px;
padding-bottom: calc(var(--composer-height) + env(safe-area-inset-bottom));
max-inline-size: 100%;
overflow-x: clip;
```

- [ ] **Step 2: Implement desktop and mobile layouts**

Desktop uses Context sidebar / Conversation main / inspector. Mobile has one main Conversation scroll; Contexts, Conversations, memory/artifacts/run, Stage Projection, and archive open as full-screen layers. The composer is sticky/fixed above the safe area and never covers the final message. Honor `prefers-reduced-motion` and visible `:focus-visible` outlines.

- [ ] **Step 3: Update the real Workflow QA fixture and tests**

The fixture must exercise:

- zero Stage Projection;
- one and 7+ dynamically named projection items;
- normal message-driven projection changes;
- agent Context/Conversation naming;
- separate user/context memory updates with metadata;
- a memory conflict/high-impact Interrupt;
- artifact and attachment flow;
- failure before initialization activation;
- historical Checkpoint Input and source preservation.

Run: `node --test lib/native-web-qa-workflow.test.mjs`

Expected: PASS through the real headless graph fixture, not a mocked Workflow response.

- [ ] **Step 4: Update documentation without unmanaged runtime instructions**

Rewrite `templates/native-web/README.md` hierarchy and endpoint sections as:

```text
User -> Context -> Route -> Conversation
                     └-> immutable Checkpoints -> optional Stage Projection snapshots
User memory: cross-Context
Context memory: current Context only
```

Document the unified Command, hidden initialization, automatic history branching, name locks, memory metadata/versioning, and dynamic projection. Remove examples that directly start Docker/dev servers on fixed ports; point developers to `polaris.json`, `Start/start.sh`, PolarPort, and PolarProcess.

- [ ] **Step 5: Run all transient gates**

Run: `npm test` from `templates/native-web`.

Expected: all API, Web, and SDK tests PASS; no unexpected skips except integration tests when no governed test database is configured.

Run: `npm run build` from `templates/native-web`.

Expected: all three workspaces build successfully.

Run: `npm run test:native-web` from `~/Polarisor/PolarUI`.

Expected: release/template tests plus Native Web tests PASS.

Run: `git diff --check`.

Expected: no whitespace errors.

- [ ] **Step 6: Run the governed production QA**

Before any persistent action, re-read the runtime contract and run:

```bash
PROJECT_ROOT=~/Polarisor/PolarUI
AUDIT=~/Polarisor/Agent_core/.cursor/skills/polar-runtime-governance/scripts/runtime-governance-audit.sh
"$AUDIT" --project "$PROJECT_ROOT"
curl -fsS --max-time 3 http://127.0.0.1:11050/api/health
curl -fsS --max-time 3 http://127.0.0.1:11055/api/health
curl -fsS --max-time 3 http://127.0.0.1:11055/api/services
curl -fsS --max-time 3 http://127.0.0.1:11050/api/list
```

Expected: both authorities are healthy. If the audit exits 2, stop persistent verification and report the blocker; never fall back to direct startup. If it exits 1, do not repair unrelated drift and continue only if the exact QA services remain governed.

Run: `npm run qa:native-release` from `~/Polarisor/PolarUI`.

Expected: the existing governed QA runner claims ports through PolarPort, registers/starts exact services through PolarProcess, completes desktop and 390px browser journeys, verifies restart recovery, and writes its JSON/Markdown/screenshots. It must not use direct `docker compose up`, raw server commands, backgrounding, or direct signals.

Finish with:

```bash
"$AUDIT" --project "$PROJECT_ROOT"
curl -fsS --max-time 3 http://127.0.0.1:11055/api/services/polarui-native-web-preview
curl -fsS --max-time 3 http://127.0.0.1:13920/readyz
```

Expected: project audit compliant, the exact service has one verified PolarProcess PID, all intended ports have one PolarPort owner, and readiness succeeds. If the QA runner uses a run-specific service instead of `polarui-native-web-preview`, query that exact ID from its report rather than guessing.

- [ ] **Step 7: Record evidence and mark tested/done truthfully**

Update only the new `polaris.json` feature. Set `test_status` to `passed` and append four complete evidence strings copied from the actual logs: the ISO date plus exact Native Web unit/integration totals; the production build and `test:native-web` result; the governed release QA passed/total count plus desktop/390px artifact paths; and the final runtime-audit/service-ID/PID/readiness result. Set `status` to `done` only when all four records exist.

Use `tested`, not `done`, if browser/restart/runtime evidence is incomplete. Use `blocked` only for a real authority/runtime blocker and record the exact failing audit/health evidence.

- [ ] **Step 8: Commit final UI/docs/QA evidence without unrelated files**

Run:

```bash
git add -p -- templates/native-web/apps/web/src/styles.css templates/native-web/apps/web/src/App.test.tsx templates/native-web/apps/web/src/commands/ThreadConversation.test.tsx templates/native-web/README.md workflows/native-web-qa lib/native-web-qa-workflow.test.mjs scripts/qa-native-release-governed.mjs polaris.json
git diff --cached --check
git diff --cached
git commit -m "test(native-web): verify core input and memory workflow"
```

Expected: only Task 11 implementation/evidence hunks are committed; output artifacts outside the repository and unrelated dirty files remain untouched.

---

## Final acceptance matrix

| Specification requirement | Primary tasks | Required evidence |
| --- | --- | --- |
| Zero Context immediately accepts Input; success creates Context/Route/Checkpoint/primary Conversation | 1, 3, 7, 8 | Command repository integration + App + governed browser QA |
| Failure retains input/attachments and exposes no empty Context | 3, 6, 8 | injected failure integration + App retry + browser QA |
| Existing Context without Conversation and untitled new Conversation are not gates | 2, 3, 7, 8 | domain/Command/App tests |
| Context/Conversation rename locks names and does not run Workflow/branch | 1, 2, 8, 10 | service route and UI focus tests |
| Input drives Workflow; Stage is optional, dynamic, read-only, and absent from Command/URL | 3, 4, 7, 9 | Bridge contract + manifest + URL + density tests |
| User/context memories have distinct extraction goals and metadata | 5, 9 | Bridge literal-goal tests + repository/API/UI tests |
| Memory revisions/invalidation are append-only; conflict/high impact interrupts | 5, 9 | concurrency integration + interrupt UI/Command tests |
| History is read-only; only historical Input creates an equal Route from exact Checkpoint | 3, 10 | repository zero-write/branch tests + UI flow |
| Desktop/mobile composer visibility, safe area, 44px targets, no horizontal scroll, keyboard/live regions | 8, 9, 11 | component accessibility tests + 390px/desktop governed QA |
| User changes and unrelated dirty files are protected | all | per-task before/after diffs and scoped staged diff review |

## Plan self-review

- Spec coverage: all sections 2–12 and acceptance groups 15.1–15.6 map to at least one task in the matrix above.
- Non-goals preserved: no Web-controlled FSM, no Conversation-as-branch, no in-place Checkpoint mutation, no Stage-owned URL/input, no special branch Route identity, and no reintroduction of local Stage notes.
- Type consistency: public naming is `Conversation`; existing `workflow_threads`/Thread filenames remain only as physical compatibility seams during migration. Public Command fields use `conversationId`; Stage data exists only as optional `StageProjectionSnapshot` results/snapshots.
- Placeholder scan: implementation steps define exact contracts, paths, commands, and expected results; no deferred fields remain.
- Runtime safety: all ordinary tests/builds are transient; the only persistent verification is explicitly guarded by PolarPort/PolarProcess preflight, exact service identity, health checks, and a final audit.
