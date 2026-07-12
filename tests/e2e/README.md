# Canvas E2E visual baselines

Playwright screenshot tests for the built GUI (`dist/`) — **dual theme** (`light` + `hermes`), one baseline each for the claude-code workflow canvas.

**Part of `npm run qa`** since R11 (steps `build` + `test:canvas-baseline`): visual acceptance is decided by the pipeline, not by eyeballing. Requires Chromium and a graphical render environment.

## Prerequisites

```bash
npm install
npm run build
npx playwright install chromium   # once per machine
```

## Run

```bash
npm run test:canvas-baseline
```

Starts `vite preview` on port 4173 (override with `POLARUI_PREVIEW_PORT`), loads the **claude-code** workflow via `localStorage` session restore (`registryId`), forces each theme via `localStorage['polarui-theme']`, and compares the canvas area screenshot per theme.

Inside `npm run qa` the `build` step runs first, so the screenshots always reflect current `src/` (stale-`dist` false greens are impossible).

## Update baselines

Re-recording baselines is the **only** manual confirmation point for intentional design changes:

```bash
npm run test:canvas-baseline -- --update-snapshots
```

## Waypoint goldens (QA gate)

Deterministic waypoint arrays are covered separately in `tests/canvas/wire-routing-snapshot.test.ts` (also in `npm run qa`). Regenerate those with:

```bash
UPDATE_GOLDEN=1 node --import tsx --test tests/canvas/wire-routing-snapshot.test.ts
```
