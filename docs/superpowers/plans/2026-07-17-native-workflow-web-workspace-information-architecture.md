# Native Workflow Web Workspace Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mixed chat/history workspace with a Stage-first workspace, on-demand Thread drawer, read-only version archive, Thread-scoped composer drafts, and equal-status Routes with optional origin metadata.

**Architecture:** Keep the existing Manifest, Workflow Bridge, Native Domain, and persistence boundaries. Move historical continuation to the existing explicit Context Route creation command, reject Workflow commands against non-head Checkpoints, split Thread attachments from Stage artifacts, and compose the Web shell from focused workspace components instead of rendering every module in one page column.

**Tech Stack:** TypeScript, React 18, Vite, Vitest, Testing Library, Fastify, PostgreSQL, Playwright, Docker Compose, PolarPort, PolarProcess.

---

## File Map

- Create `PolarUI/templates/native-web/apps/web/src/workspace/VersionArchive.tsx`: read-only Checkpoint browser and explicit Route creation form.
- Create `PolarUI/templates/native-web/apps/web/src/workspace/ThreadDrawer.tsx`: desktop drawer and mobile full-screen discussion surface.
- Create `PolarUI/templates/native-web/apps/web/src/assets/AttachmentPanel.tsx`: Thread-only uploads and attachment list.
- Create `PolarUI/templates/native-web/apps/web/src/assets/ArtifactPanel.tsx`: Route/Stage accepted artifact list.
- Modify `PolarUI/templates/native-web/apps/web/src/App.tsx`: remove Stage memo and historical workspace, orchestrate normal Routes, archive, and drawer.
- Modify `PolarUI/templates/native-web/apps/web/src/commands/ThreadConversation.tsx`: persist only composer drafts and remove historical-branch language.
- Modify `PolarUI/templates/native-web/apps/web/src/auth/storage.ts`: replace URL memo storage with user-scoped Thread composer storage.
- Modify `PolarUI/templates/native-web/apps/web/src/stages/StageWorkspace.tsx`: render the Stage work object and accepted artifacts, not attachments or conversation.
- Modify `PolarUI/templates/native-web/apps/web/src/assets/api.ts`: expose Thread attachment and Stage artifact reads separately.
- Modify `PolarUI/templates/native-web/apps/web/src/styles.css`: implement Stage-first shell, drawer, archive, and mobile layers.
- Modify `PolarUI/templates/native-web/apps/api/src/commands/service.ts`: reject commands based on non-head Checkpoints.
- Modify `PolarUI/templates/native-web/apps/api/src/commands/types.ts`: remove automatic derived Route finalization IDs.
- Modify `PolarUI/templates/native-web/apps/api/src/commands/repository.ts`: remove implicit historical branching from command commit.
- Modify `PolarUI/templates/native-web/apps/api/src/assets/repository.ts`: list attachments by Thread and artifacts by Route/Stage.
- Modify `PolarUI/templates/native-web/apps/api/src/assets/service.ts`: expose the separated asset reads.
- Modify `PolarUI/templates/native-web/apps/api/src/routes/assets.ts`: add the Route/Stage artifact endpoint.
- Modify matching Web/API unit and integration tests.
- Modify `PolarUI/scripts/qa-native-release-governed.mjs`: assert the new information architecture in the real exported production container.

### Task 1: Forbid Workflow Commands From Archived Versions

**Files:**
- Modify: `PolarUI/templates/native-web/apps/api/src/commands/service.ts`
- Modify: `PolarUI/templates/native-web/apps/api/src/commands/types.ts`
- Modify: `PolarUI/templates/native-web/apps/api/src/commands/repository.ts`
- Test: `PolarUI/templates/native-web/apps/api/tests/command-service.test.ts`
- Test: `PolarUI/templates/native-web/apps/api/tests/command-repository.integration.test.ts`
- Test: `PolarUI/templates/native-web/apps/api/tests/command-routes.integration.test.ts`

- [ ] **Step 1: Write the failing service test**

Add a case where `prepareExecution()` reports a historical base and assert that command creation fails with `CHECKPOINT_NOT_CURRENT` before the Workflow Bridge is called.

```ts
await expect(service.createCommand(userId, threadId, historicalInput))
  .rejects.toMatchObject({ code: 'CHECKPOINT_NOT_CURRENT', statusCode: 409 });
expect(bridge.run).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-api -- command-service.test.ts`

Expected: FAIL because historical commands currently allocate automatic derived Route and Thread IDs.

- [ ] **Step 3: Reject the historical command before execution**

In `createCommand`, convert the prepared historical state into a typed conflict:

```ts
if (!claimed.execution.baseIsHead) {
  throw new CommandServiceError('CHECKPOINT_NOT_CURRENT', 409);
}
```

Remove `derivedRouteId`, `derivedThreadId`, `derivedRouteName`, and `derivedThreadTitle` from `FinalizeActionIds`. Simplify action finalization so it only commits to `source_route_id` and `source_thread_id`; explicit `POST /api/contexts/:contextId/routes` remains the sole archived-version continuation path.

- [ ] **Step 4: Update repository and route tests**

Replace implicit branching assertions with assertions that:

```ts
expect(result.status).toBe('conflict');
expect(result.errorCode).toBe('CHECKPOINT_NOT_CURRENT');
expect(await countRoutes(contextId)).toBe(1);
expect(await countThreads(contextId)).toBe(1);
```

- [ ] **Step 5: Run API command tests**

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-api -- command-service.test.ts command-routes.integration.test.ts command-repository.integration.test.ts`

Expected: PASS with no `派生路线` or `派生讨论` generation path.

- [ ] **Step 6: Commit the command boundary**

```bash
git add PolarUI/templates/native-web/apps/api/src/commands PolarUI/templates/native-web/apps/api/tests/command-*.test.ts PolarUI/templates/native-web/apps/api/tests/command-*.integration.test.ts
git commit -m "refactor(polarui): make archived versions explicitly read only"
```

### Task 2: Replace Stage Notes With Thread Composer Drafts

**Files:**
- Modify: `PolarUI/templates/native-web/apps/web/src/auth/storage.ts`
- Modify: `PolarUI/templates/native-web/apps/web/src/auth/storage.test.ts`
- Modify: `PolarUI/templates/native-web/apps/web/src/commands/ThreadConversation.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/commands/ThreadConversation.test.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/App.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/App.test.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/auth/auth.test.tsx`

- [ ] **Step 1: Write failing storage isolation tests**

Define a structured scope and verify user/Thread isolation and legacy-key cleanup:

```ts
const scope = {
  productId: 'demo', userId: 'user-a', contextId: 'context-a',
  routeId: 'route-a', stageKey: 'discover', threadId: 'thread-a',
};
writeComposerDraft(scope, 'draft A');
expect(readComposerDraft(scope)).toBe('draft A');
expect(readComposerDraft({ ...scope, userId: 'user-b' })).toBe('');
clearComposerDraft(scope);
expect(readComposerDraft(scope)).toBe('');
```

- [ ] **Step 2: Run storage tests and verify they fail**

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-web -- storage.test.ts`

Expected: FAIL because only URL-scoped `readDraft` and `writeDraft` exist.

- [ ] **Step 3: Implement composer draft storage**

Export `ComposerDraftScope`, `readComposerDraft`, `writeComposerDraft`, and `clearComposerDraft`. Build the storage key from every scope field and encode each value. Do not read or migrate `polar-native:<product>:draft:<url>` keys.

- [ ] **Step 4: Persist the ThreadConversation composer**

Add `draftScope: ComposerDraftScope` to `ThreadConversation`. Load on scope change, save on change, retain on failure, and clear only after a successful message command:

```ts
useEffect(() => setDraft(readComposerDraft(draftScope)), [draftKey]);
const updateDraft = (value: string) => {
  setDraft(value);
  writeComposerDraft(draftScope, value);
};
// successful message
clearComposerDraft(draftScope);
setDraft('');
```

- [ ] **Step 5: Remove Stage memo state and tests from App**

Delete `draft`, `draftPath`, the two “阶段草稿” textareas, `.stage-memo`, and auth tests that expect a URL memo. Replace them with tests asserting that no “当前浏览位置的未提交笔记” or “阶段草稿” control renders.

- [ ] **Step 6: Run Web draft tests**

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-web -- storage.test.ts ThreadConversation.test.tsx App.test.tsx auth.test.tsx`

Expected: PASS; composer drafts survive Thread switching and failures but remain isolated by user and Thread.

- [ ] **Step 7: Commit composer drafts**

```bash
git add PolarUI/templates/native-web/apps/web/src/auth PolarUI/templates/native-web/apps/web/src/commands PolarUI/templates/native-web/apps/web/src/App.tsx PolarUI/templates/native-web/apps/web/src/App.test.tsx
git commit -m "refactor(polarui): scope drafts to discussion composers"
```

### Task 3: Separate Thread Attachments From Stage Artifacts

**Files:**
- Create: `PolarUI/templates/native-web/apps/web/src/assets/AttachmentPanel.tsx`
- Create: `PolarUI/templates/native-web/apps/web/src/assets/ArtifactPanel.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/assets/api.ts`
- Delete: `PolarUI/templates/native-web/apps/web/src/assets/AssetPanel.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/stages/StageWorkspace.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/stages/StageWorkspace.test.tsx`
- Modify: `PolarUI/templates/native-web/apps/api/src/assets/repository.ts`
- Modify: `PolarUI/templates/native-web/apps/api/src/assets/service.ts`
- Modify: `PolarUI/templates/native-web/apps/api/src/routes/assets.ts`
- Test: `PolarUI/templates/native-web/apps/api/tests/asset-service.test.ts`
- Test: `PolarUI/templates/native-web/apps/api/tests/phase5-routes.test.ts`

- [ ] **Step 1: Write failing asset ownership tests**

Assert that the Thread endpoint returns only attachments and the Stage endpoint returns only ready artifacts:

```ts
expect(await service.listThreadAttachments(userId, threadId))
  .toEqual({ attachments: [attachment] });
expect(await service.listStageArtifacts(userId, routeId, 'work'))
  .toEqual({ artifacts: [readyArtifact] });
```

- [ ] **Step 2: Run focused asset tests and verify they fail**

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-api -- asset-service.test.ts phase5-routes.test.ts`

Expected: FAIL because the current Thread read unions attachments and artifacts.

- [ ] **Step 3: Split repository and routes**

Change the Thread query to select only `workflow_attachments`. Add an owned Route/Stage artifact query and route:

```text
GET /api/routes/:routeId/stages/:stageKey/artifacts
```

The query must join `contexts` for `user_id`, filter `workflow_artifacts.status = 'ready'`, and never return Thread attachments.

- [ ] **Step 4: Split Web panels**

`AttachmentPanel` owns upload and Thread attachment rendering. `ArtifactPanel` receives `routeId`, `stageKey`, and `revision`, and renders the heading “成果”. `StageWorkspace` renders only `ArtifactPanel`; the Thread drawer renders `AttachmentPanel` and `ProposalPanel`.

- [ ] **Step 5: Run asset and Stage component tests**

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-api -- asset-service.test.ts phase5-routes.test.ts`

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-web -- StageWorkspace.test.tsx`

Expected: PASS with attachment upload absent from Stage Workspace.

- [ ] **Step 6: Commit the ownership split**

```bash
git add PolarUI/templates/native-web/apps/api/src/assets PolarUI/templates/native-web/apps/api/src/routes/assets.ts PolarUI/templates/native-web/apps/api/tests/asset-service.test.ts PolarUI/templates/native-web/apps/api/tests/phase5-routes.test.ts PolarUI/templates/native-web/apps/web/src/assets PolarUI/templates/native-web/apps/web/src/stages
git commit -m "refactor(polarui): separate discussion attachments from stage artifacts"
```

### Task 4: Add the Read-Only Version Archive

**Files:**
- Create: `PolarUI/templates/native-web/apps/web/src/workspace/VersionArchive.tsx`
- Create: `PolarUI/templates/native-web/apps/web/src/workspace/VersionArchive.test.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/domain/api.ts`
- Modify: `PolarUI/templates/native-web/apps/web/src/domain/api.test.ts`
- Modify: `PolarUI/templates/native-web/apps/web/src/App.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/App.test.tsx`

- [ ] **Step 1: Write the failing archive component tests**

Render two Checkpoints and verify the archive is read-only and creates a normal Route only through the explicit action:

```ts
expect(screen.queryByLabelText('消息内容')).not.toBeInTheDocument();
expect(screen.queryByRole('button', { name: '推进阶段' })).not.toBeInTheDocument();
await user.click(screen.getByRole('button', { name: '基于此版本新建路线' }));
await user.type(screen.getByLabelText('新路线名称'), '精简方案');
await user.click(screen.getByRole('button', { name: '创建路线' }));
expect(onCreateRoute).toHaveBeenCalledWith(checkpoint.id, '精简方案');
```

- [ ] **Step 2: Run the component test and verify it fails**

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-web -- VersionArchive.test.tsx`

Expected: FAIL because `VersionArchive` does not exist.

- [ ] **Step 3: Implement VersionArchive**

Render a dialog with a version list and selected snapshot. Translate reasons as `路线建立`, `基于版本创建`, and `受控动作`. Expose only close, version select, and route creation controls. Keep the legacy LibreChat `ArchivePanel` labeled as imported archive so the two archives are not conflated.

- [ ] **Step 4: Remove historical Checkpoint navigation from App**

Delete the Checkpoint section and `checkpoint` query navigation from the normal workspace. Rename the Web/domain helper from `branchRoute` to `createRouteFromVersion`, while retaining the stable HTTP endpoint. Add a “版本” button that opens `VersionArchive`. After successful Route creation, refresh Context routes and open the returned Route at the source Stage.

- [ ] **Step 5: Run archive and App tests**

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-web -- VersionArchive.test.tsx App.test.tsx domain/api.test.ts`

Expected: PASS; archived versions contain no Thread or command controls.

- [ ] **Step 6: Commit the archive**

```bash
git add PolarUI/templates/native-web/apps/web/src/workspace/VersionArchive.tsx PolarUI/templates/native-web/apps/web/src/workspace/VersionArchive.test.tsx PolarUI/templates/native-web/apps/web/src/domain PolarUI/templates/native-web/apps/web/src/App.tsx PolarUI/templates/native-web/apps/web/src/App.test.tsx
git commit -m "feat(polarui): move checkpoints into a read only version archive"
```

### Task 5: Build the Stage-First Workspace and Thread Drawer

**Files:**
- Create: `PolarUI/templates/native-web/apps/web/src/workspace/ThreadDrawer.tsx`
- Create: `PolarUI/templates/native-web/apps/web/src/workspace/ThreadDrawer.test.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/App.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/App.test.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/stages/StageWorkspace.tsx`
- Modify: `PolarUI/templates/native-web/apps/web/src/styles.css`

- [ ] **Step 1: Write failing drawer behavior tests**

Assert the drawer is closed by default, opens from a count button, switches same-Stage Threads, and restores focus on close:

```ts
expect(screen.queryByRole('dialog', { name: '阶段讨论' })).not.toBeInTheDocument();
await user.click(screen.getByRole('button', { name: '打开讨论，2 个' }));
expect(screen.getByRole('dialog', { name: '阶段讨论' })).toBeInTheDocument();
await user.click(screen.getByRole('tab', { name: '风险复核' }));
expect(onSelectThread).toHaveBeenCalledWith(threadB.id);
```

- [ ] **Step 2: Run drawer tests and verify they fail**

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-web -- ThreadDrawer.test.tsx App.test.tsx`

Expected: FAIL because Threads currently occupy a permanent third column and conversation occupies the central flow.

- [ ] **Step 3: Implement ThreadDrawer**

The drawer owns Thread tabs, create/rename/archive controls, `ThreadConversation`, `AttachmentPanel`, and pending memory proposals. It receives callbacks from App and does not fetch Route workspace state itself.

- [ ] **Step 4: Recompose App**

Use this stable layout:

```tsx
<div className="app-shell">
  <ProductBar />
  <aside className="workspace-navigator">{/* Context, Route, and Stage navigation */}</aside>
  <main className="workspace-main">
    <StageWorkspace />
    <button aria-label={`打开讨论，${threads.length} 个`} />
  </main>
  {threadDrawerOpen && <ThreadDrawer />}
  {versionArchiveOpen && <VersionArchive />}
</div>
```

Routes with `originCheckpointId` use the same markup and controls as every other Route. Show only a compact source line. Remove “主线”, “派生路线”, “派生讨论”, “讨论工作台”, and the explanatory footer from visible UI.

- [ ] **Step 5: Implement responsive CSS**

Desktop: navigator plus full-width Stage workspace, with a fixed right drawer no wider than `min(440px, 42vw)`. Mobile at `max-width: 720px`: navigator becomes compact horizontal navigation, Thread drawer fills the viewport, and version archive uses a single-column list/detail flow. Use stable button and grid dimensions and no nested cards.

- [ ] **Step 6: Run Web tests and production build**

Run: `npm test --prefix PolarUI/templates/native-web --workspace @polar/native-web-web`

Run: `npm run build --prefix PolarUI/templates/native-web`

Expected: all Web tests pass and Vite production build succeeds.

- [ ] **Step 7: Commit the workspace shell**

```bash
git add PolarUI/templates/native-web/apps/web/src/App.tsx PolarUI/templates/native-web/apps/web/src/App.test.tsx PolarUI/templates/native-web/apps/web/src/workspace PolarUI/templates/native-web/apps/web/src/stages PolarUI/templates/native-web/apps/web/src/styles.css
git commit -m "feat(polarui): center native workflow stages and fold discussions"
```

### Task 6: Update and Run the Full Release QA Pipeline

**Files:**
- Modify: `PolarUI/scripts/qa-native-release-governed.mjs`
- Modify: `PolarUI/scripts/qa-native-release-governed.test.mjs`
- Update generated reports and screenshots under `~/Documents/Codex/2026-07-16/workflow-web-deploy-qa/outputs/`

- [ ] **Step 1: Update static QA contract assertions**

Require the governed QA script to assert:

```js
assert.equal(await page.getByText('当前浏览位置的未提交笔记').count(), 0);
assert.equal(await page.getByText('派生路线').count(), 0);
await page.getByRole('button', { name: /打开讨论/ }).click();
await page.getByRole('dialog', { name: '阶段讨论' }).waitFor();
await page.getByRole('button', { name: '版本' }).click();
await page.getByRole('dialog', { name: '版本归档' }).waitFor();
```

Keep all existing registration, login, Context, multi-Thread, Workflow, adoption, advance, memory, archive, isolation, idempotency, conflict, timeout, invalid result, refresh, and restart checks.

- [ ] **Step 2: Run focused release/governance tests**

Run: `cd PolarUI && node --test scripts/native-template.test.mjs scripts/compile-product-manifest.test.mjs scripts/verify-release.test.mjs scripts/governed-qa-services.test.mjs scripts/qa-native-release-governed.test.mjs`

Expected: all focused release and governance tests pass.

- [ ] **Step 3: Run the complete Native Web suite**

Run: `cd PolarUI && npm run test:native-web`

Expected: all Native Web unit and integration tests pass.

- [ ] **Step 4: Run the governed production release QA**

Run: `cd PolarUI && npm run qa:native-release`

Expected: export-release succeeds; PolarPort allocates every listener; PolarProcess manages Workflow runtime, mail capture, TLS proxy, Compose foreground process, and production Web service; all browser/API checks pass.

- [ ] **Step 5: Inspect desktop and mobile screenshots**

Verify the generated desktop and 390 px mobile screenshots show the Stage work object as primary content, no overlapping modules, a closed default discussion drawer, a full-screen mobile discussion layer, and a read-only version archive.

- [ ] **Step 6: Verify runtime recovery and governance**

Confirm `/readyz`, Polar runtime audit, Compose managed PID ownership, and production state recovery after container restart. No listener may be started outside PolarPort/PolarProcess.

- [ ] **Step 7: Write the final QA report and commit**

Update the Markdown/JSON report with command evidence, counts, screenshots, production service IDs, ports, and explicit failures. Then commit only the implementation and QA source changes that remain uncommitted:

```bash
git add PolarUI/scripts/qa-native-release-governed.mjs PolarUI/scripts/qa-native-release-governed.test.mjs
git commit -m "test(polarui): validate layered native workflow workspace"
```
