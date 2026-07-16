# Native Workflow Web Release QA Implementation Plan

> **For agentic workers:** Execute inline with TDD and verify every persistent service through PolarPort and PolarProcess.

**Goal:** Prove a completed PolarUI Workflow can be exported as a native Web release, deployed with one command, and accepted in a real production container with repeatable browser evidence.

**Architecture:** A deterministic `native-web-qa` graph runs through the real PolarUI headless engine behind a governed Workflow Runtime. `export-release` freezes that graph and its product manifest, then `deploy-web-release` registers the production Compose process with PolarProcess. The QA runner drives only public HTTP/browser behavior and lifecycle authority APIs.

**Tech Stack:** Node.js 22, TypeScript, PolarUI headless graph engine, React/Vite, PostgreSQL 16, Docker Compose, Mailpit, Playwright, PolarPort, PolarProcess.

---

### Task 1: Freeze the manifest/release contract

**Files:**
- Modify: `scripts/compile-product-manifest.mjs`
- Modify: `scripts/compile-product-manifest.test.mjs`
- Modify: `scripts/verify-release.mjs`
- Modify: `scripts/verify-release.test.mjs`

- [ ] Add failing tests proving compiler preserves the source endpoint and release verification rejects manifest/snapshot identity drift.
- [ ] Run the focused Node tests and confirm the contract failures.
- [ ] Implement endpoint preservation plus cross-artifact verification.
- [ ] Re-run the focused tests and the complete export-release suite.

### Task 2: Add a real executable Workflow fixture

**Files:**
- Create: `workflows/native-web-qa/native-web-qa.json`
- Create: `workflows/native-web-qa/product.manifest.json`
- Create: `workflows/native-web-qa/registry-entry.json`
- Modify: `lib/run-graph.mjs`
- Modify: `lib/run-graph-server.mjs`
- Test: `lib/run-graph-server.test.mjs`

- [ ] Add failing runtime tests for full Command Envelope propagation and deterministic fixture outputs.
- [ ] Run tests and confirm the fixture cannot yet execute.
- [ ] Add the smallest fixture executor/graph integration needed for reply, proposal, Stage, interrupt, timeout and invalid-result cases.
- [ ] Run the graph directly and through `POST /run`; assert `node_traces` proves headless graph execution.

### Task 3: Govern the production QA topology

**Files:**
- Modify: `scripts/qa-native-identity-release.mjs`
- Create: `scripts/native-release-qa-runtime.mjs`
- Modify: `package.json`

- [ ] Add focused tests for service registration bodies and cleanup behavior.
- [ ] Replace script-owned listeners and direct detached containers with PolarPort claims and PolarProcess registrations.
- [ ] Route restart/recovery through `POST /api/services/:id/restart`.
- [ ] Persist a JSON report, browser screenshots and explicit failure records.

### Task 4: Execute and verify the release journey

**Files:**
- Update: `polaris.json`
- Create: `docs/qa/2026-07-16-native-workflow-web-release-report.md`

- [ ] Run Native Web unit/integration tests and production builds.
- [ ] Export `native-web-qa` with deployment enabled and verify release checksums/artifacts.
- [ ] Run the browser journey for registration/verification/login, Context/Route/Stage/Thread/Checkpoint, commands, proposals, assets, archive, isolation, conflicts and failure modes.
- [ ] Restart the exact production service through PolarProcess and verify PostgreSQL/object/session recovery.
- [ ] Run final runtime-governance audit and `/readyz` check, then record commands, versions, screenshots and any failures.
