# Native Workflow Web Template Phase 1 Implementation Plan

> **Execution mode:** Use ordinary task-level SubAgents coordinated directly by the Main Agent. Do not invoke `superpowers:subagent-driven-development`, `superpowers:executing-plans`, or any other Superpowers execution workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tracked, production-buildable native Workflow Web template with a validated product manifest, fixed minimal product shell, one public container, and an opt-in native export path that does not contain or run LibreChat.

**Architecture:** Add the native template under the tracked `PolarUI/templates/native-web/` source tree because the current `~/Desktop/Web_related/_template` directory is not in Git. Phase 1 keeps the legacy exporter as the default while adding `--template-flavor native`; a native export copies the tracked template, compiles `product.manifest.json`, builds one Node-served React application, and passes release verification plus a real-container browser smoke test. Later plans add PostgreSQL/authentication, lineage persistence, the Workflow Bridge, artifacts, and LibreChat history import before native becomes the only default.

**Tech Stack:** Node.js 22+, TypeScript, npm workspaces, React, Vite, Fastify, Zod, Vitest, Testing Library, Playwright, Docker, existing PolarUI `node:test` exporter tests.

---

## Ordinary SubAgent collaboration protocol

This plan uses regular SubAgent delegation without a Superpowers orchestration skill:

1. The Main Agent owns the complete plan, dependency order, task boundaries, integration decisions, diff review, exact staging, checkpoint commits, and final acceptance.
2. Tasks 1–9 are assigned one at a time to an ordinary task-level SubAgent. Each assignment must include the complete task text, allowed file list, relevant repository context, and exact acceptance commands.
3. A SubAgent may modify only the files declared by its assigned task, must follow the test-first steps in that task, and must report changed files plus command results. It must not run `git add`, create commits, or broaden scope.
4. After a SubAgent reports completion, the Main Agent reviews the diff and reruns the task's acceptance commands. Only the Main Agent may stage the exact task files and create the checkpoint commit.
5. If review or verification fails, the Main Agent returns the bounded defect to the same SubAgent for correction, then repeats review and verification before committing.
6. Execute tasks sequentially in dependency order: `1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10`. Do not parallelize this phase because the workspace lockfile and export pipeline are shared.
7. Task 10 is Main-Agent-only. Its full verification commands are the release gate and may not be delegated.
8. The real Docker container and Playwright checks in Tasks 9 and 10 are mandatory. Unit or mocked tests may not replace them.

The existing `docs/superpowers/plans/` path is retained only to preserve current links; it does not imply a Superpowers runtime or skill dependency.

## Scope boundary

This plan implements only the first independently testable vertical slice:

1. tracked native template source;
2. product manifest schema and component registry contract;
3. fixed minimal shell with context/route/stage/thread slots;
4. production Node server and Docker image;
5. opt-in native export, verification, deployment metadata, and browser smoke test.

Do not implement database persistence, email authentication, workflow execution, artifacts, route forking, thread adoption, or LibreChat import in this phase. Those require separate plans and must not be represented by fake production APIs.

## File map

### Tracked native template

- Create `PolarUI/templates/native-web/package.json` — workspace scripts and shared dependency versions.
- Create `PolarUI/templates/native-web/package-lock.json` — reproducible workspace dependency lockfile, first generated in Task 2.
- Create `PolarUI/templates/native-web/tsconfig.json` — shared TypeScript configuration.
- Create `PolarUI/templates/native-web/product.manifest.json` — default single-stage manifest used by direct template development.
- Create `PolarUI/templates/native-web/packages/product-sdk/src/manifest.ts` — Zod manifest contract.
- Create `PolarUI/templates/native-web/packages/product-sdk/src/index.ts` — public SDK exports.
- Create `PolarUI/templates/native-web/packages/product-sdk/tests/manifest.test.ts` — contract tests.
- Create `PolarUI/templates/native-web/apps/api/src/app.ts` — Fastify app, health and bootstrap endpoints, production static hosting.
- Create `PolarUI/templates/native-web/apps/api/src/server.ts` — process entry point.
- Create `PolarUI/templates/native-web/apps/api/tests/app.test.ts` — API tests.
- Create `PolarUI/templates/native-web/apps/web/src/main.tsx` — React entry.
- Create `PolarUI/templates/native-web/apps/web/src/App.tsx` — fixed product shell.
- Create `PolarUI/templates/native-web/apps/web/src/styles.css` — minimal responsive default design system.
- Create `PolarUI/templates/native-web/apps/web/src/App.test.tsx` — shell behavior tests.
- Create `PolarUI/templates/native-web/apps/web/index.html` — Vite document.
- Create `PolarUI/templates/native-web/apps/web/vite.config.ts` — build and test configuration.
- Create `PolarUI/templates/native-web/Dockerfile` — multi-stage production image.
- Create `PolarUI/templates/native-web/compose.yml` — local production-like launch.
- Create `PolarUI/templates/native-web/.dockerignore` — build context exclusions.
- Create `PolarUI/templates/native-web/README.md` — local development and release commands.

### PolarUI export pipeline

- Create `PolarUI/scripts/native-template.mjs` — resolve template flavor and source directory.
- Create `PolarUI/scripts/native-template.test.mjs` — flavor/source tests.
- Create `PolarUI/scripts/compile-product-manifest.mjs` — load, normalize, and validate workflow product manifests.
- Create `PolarUI/scripts/compile-product-manifest.test.mjs` — compile tests.
- Modify `PolarUI/scripts/export-release.mjs` — accept `--template-flavor`, scaffold the native template, and skip LibreChat patching for native exports.
- Modify `PolarUI/scripts/export-release.test.mjs` — native export assertions.
- Modify `PolarUI/scripts/compile-site-config.mjs` — emit native web metadata.
- Modify `PolarUI/scripts/compile-site-config.test.mjs` — native config tests.
- Modify `PolarUI/scripts/verify-release.mjs` — flavor-specific required files and forbidden legacy files.
- Create `PolarUI/scripts/verify-release.test.mjs` — native verification tests.
- Modify `PolarUI/scripts/deploy-web-release.mjs` — one native web service and one public port.
- Modify `PolarUI/package.json` — native template and QA scripts.
- Create `PolarUI/scripts/qa-native-web-release.mjs` — actual image/container/browser smoke test.

## Task 1: Establish the tracked native template workspace

**Files:**
- Create: `PolarUI/scripts/native-template.mjs`
- Create: `PolarUI/scripts/native-template.test.mjs`
- Create: `PolarUI/templates/native-web/package.json`
- Create: `PolarUI/templates/native-web/tsconfig.json`
- Create: `PolarUI/templates/native-web/product.manifest.json`
- Create: `PolarUI/templates/native-web/README.md`

- [ ] **Step 1: Write the failing template source test**

Create `PolarUI/scripts/native-template.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveTemplateSource } from './native-template.mjs';

const polaruiRoot = join(import.meta.dirname, '..');

test('native flavor resolves to tracked PolarUI template', () => {
  assert.equal(
    resolveTemplateSource({ flavor: 'native', polaruiRoot, webRoot: '/tmp/web-root' }),
    join(polaruiRoot, 'templates/native-web'),
  );
});

test('legacy flavor resolves to Web_related compatibility template', () => {
  assert.equal(
    resolveTemplateSource({ flavor: 'legacy', polaruiRoot, webRoot: '/tmp/web-root' }),
    '/tmp/web-root/_template',
  );
});

test('unknown flavor is rejected', () => {
  assert.throws(
    () => resolveTemplateSource({ flavor: 'recursive-ui', polaruiRoot, webRoot: '/tmp/web-root' }),
    /unsupported template flavor/,
  );
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd ~/Polarisor/PolarUI
node --test scripts/native-template.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/native-template.mjs`.

- [ ] **Step 3: Implement template source resolution**

Create `PolarUI/scripts/native-template.mjs`:

```js
import { join } from 'node:path';

export const TEMPLATE_FLAVORS = Object.freeze(['legacy', 'native']);

export function resolveTemplateSource({ flavor, polaruiRoot, webRoot }) {
  if (flavor === 'native') return join(polaruiRoot, 'templates/native-web');
  if (flavor === 'legacy') return join(webRoot, '_template');
  throw new Error(`unsupported template flavor: ${flavor}`);
}
```

- [ ] **Step 4: Create the workspace root**

Create `PolarUI/templates/native-web/package.json`:

```json
{
  "name": "@polar/native-web-template",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build -w @polar/native-web-product-sdk && npm run build -w @polar/native-web-web && npm run build -w @polar/native-web-api",
    "start": "npm run start -w @polar/native-web-api",
    "test": "npm run test -ws --if-present",
    "test:unit": "npm run test -ws --if-present",
    "dev:web": "npm run dev -w @polar/native-web-web",
    "dev:api": "npm run dev -w @polar/native-web-api"
  },
  "engines": {
    "node": ">=22"
  }
}
```

Create `PolarUI/templates/native-web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

Create `PolarUI/templates/native-web/product.manifest.json`:

```json
{
  "contract_version": "1.0",
  "product": {
    "id": "native-web-template",
    "name": "Workflow Workspace",
    "context_label": "情境",
    "route_label": "路线"
  },
  "workflow": {
    "id": "demo",
    "endpoint": "http://127.0.0.1:8065/run/demo/flow.json"
  },
  "stages": [
    {
      "key": "work",
      "label": "开始工作",
      "component_key": "generic_chat",
      "internal_states": ["start", "done"],
      "actions": []
    }
  ]
}
```

Create `PolarUI/templates/native-web/README.md`:

````md
# Polar Native Workflow Web Template

Tracked source for native Polar workflow web releases. This implementation is independent from the legacy chat runtime.

```bash
npm install
npm test
npm run build
npm start
```

The default local URL is `http://127.0.0.1:3920`.
````

- [ ] **Step 5: Run the resolver test**

Run:

```bash
cd ~/Polarisor/PolarUI
node --test scripts/native-template.test.mjs
```

Expected: 3 tests PASS.

- [ ] **Step 6: Main Agent review and checkpoint commit**

The Main Agent reviews the task diff, reruns the resolver test, and then runs:

```bash
cd ~/Polarisor
git add PolarUI/scripts/native-template.mjs PolarUI/scripts/native-template.test.mjs PolarUI/templates/native-web/package.json PolarUI/templates/native-web/tsconfig.json PolarUI/templates/native-web/product.manifest.json PolarUI/templates/native-web/README.md
git commit -m "feat(polarui): add tracked native web template foundation"
```

## Task 2: Define and validate the product manifest contract

**Files:**
- Create: `PolarUI/templates/native-web/package-lock.json`
- Create: `PolarUI/templates/native-web/packages/product-sdk/package.json`
- Create: `PolarUI/templates/native-web/packages/product-sdk/tsconfig.json`
- Create: `PolarUI/templates/native-web/packages/product-sdk/src/manifest.ts`
- Create: `PolarUI/templates/native-web/packages/product-sdk/src/index.ts`
- Create: `PolarUI/templates/native-web/packages/product-sdk/tests/manifest.test.ts`

- [ ] **Step 1: Write failing manifest contract tests**

Create `PolarUI/templates/native-web/packages/product-sdk/tests/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseProductManifest } from '../src/manifest.js';

const valid = {
  contract_version: '1.0',
  product: { id: 'research', name: 'Research', context_label: '项目', route_label: '路线' },
  workflow: { id: 'research-loop', endpoint: 'http://engine/run/research-loop/flow.json' },
  stages: [
    {
      key: 'define',
      label: '定义问题',
      component_key: 'structured_form',
      internal_states: ['start', 'clarify'],
      actions: [{ key: 'confirm_problem', label: '确认问题' }],
    },
  ],
};

describe('parseProductManifest', () => {
  it('accepts a bounded stage manifest', () => {
    expect(parseProductManifest(valid).stages[0].key).toBe('define');
  });

  it('rejects duplicate stage keys', () => {
    expect(() => parseProductManifest({ ...valid, stages: [valid.stages[0], valid.stages[0]] }))
      .toThrow(/duplicate stage key/);
  });

  it('rejects arbitrary recursive layout data', () => {
    expect(() => parseProductManifest({ ...valid, layout: { children: [] } }))
      .toThrow();
  });

  it('rejects unknown built-in components', () => {
    const stages = [{ ...valid.stages[0], component_key: 'recursive_page_builder' }];
    expect(() => parseProductManifest({ ...valid, stages })).toThrow(/component_key/);
  });

  it('rejects duplicate action keys inside a stage', () => {
    const action = { key: 'confirm_problem', label: '确认问题' };
    const stages = [{ ...valid.stages[0], actions: [action, action] }];
    expect(() => parseProductManifest({ ...valid, stages })).toThrow(/duplicate action key/);
  });
});
```

- [ ] **Step 2: Run the package test and verify it fails**

Run:

```bash
cd ~/Polarisor/PolarUI/templates/native-web
npm test -w @polar/native-web-product-sdk
```

Expected: FAIL because the product SDK workspace and manifest parser do not exist. This step must not install dependencies or modify the workspace root.

- [ ] **Step 3: Create the SDK package metadata**

Create `PolarUI/templates/native-web/packages/product-sdk/package.json`:

```json
{
  "name": "@polar/native-web-product-sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.2.0"
  }
}
```

Create `PolarUI/templates/native-web/packages/product-sdk/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Implement the bounded manifest schema**

Create `PolarUI/templates/native-web/packages/product-sdk/src/manifest.ts`:

```ts
import { z } from 'zod';

export const BUILTIN_COMPONENT_KEYS = [
  'generic_chat',
  'structured_form',
  'card_selection',
  'document_workspace',
] as const;

const actionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(80),
}).strict();

const stageSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(80),
  component_key: z.enum(BUILTIN_COMPONENT_KEYS),
  internal_states: z.array(z.string().min(1)).min(1),
  actions: z.array(actionSchema),
}).strict();

const manifestSchema = z.object({
  contract_version: z.literal('1.0'),
  product: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(100),
    context_label: z.string().min(1).max(30),
    route_label: z.string().min(1).max(30),
  }).strict(),
  workflow: z.object({
    id: z.string().min(1),
    endpoint: z.string().url(),
  }).strict(),
  stages: z.array(stageSchema).min(1),
}).strict();

export type ProductManifest = z.infer<typeof manifestSchema>;

export function parseProductManifest(input: unknown): ProductManifest {
  const parsed = manifestSchema.parse(input);
  const stageKeys = new Set<string>();
  for (const stage of parsed.stages) {
    if (stageKeys.has(stage.key)) throw new Error(`duplicate stage key: ${stage.key}`);
    stageKeys.add(stage.key);
    const actionKeys = new Set<string>();
    for (const action of stage.actions) {
      if (actionKeys.has(action.key)) {
        throw new Error(`duplicate action key in ${stage.key}: ${action.key}`);
      }
      actionKeys.add(action.key);
    }
  }
  return parsed;
}
```

Create `PolarUI/templates/native-web/packages/product-sdk/src/index.ts`:

```ts
export {
  BUILTIN_COMPONENT_KEYS,
  parseProductManifest,
  type ProductManifest,
} from './manifest.js';
```

- [ ] **Step 5: Install and run the SDK tests**

Run:

```bash
cd ~/Polarisor/PolarUI/templates/native-web
npm install
npm run test -w @polar/native-web-product-sdk
npm run build -w @polar/native-web-product-sdk
```

Expected: 5 tests PASS and `packages/product-sdk/dist/index.js` exists.

- [ ] **Step 6: Main Agent review and checkpoint commit**

The Main Agent reviews the task diff, reruns the manifest package tests, and then runs:

```bash
cd ~/Polarisor
git add PolarUI/templates/native-web/package-lock.json PolarUI/templates/native-web/packages/product-sdk
git commit -m "feat(polarui): define bounded product manifest contract"
```

## Task 3: Add the native API bootstrap and production static server

**Files:**
- Modify: `PolarUI/templates/native-web/package-lock.json`
- Create: `PolarUI/templates/native-web/apps/api/package.json`
- Create: `PolarUI/templates/native-web/apps/api/tsconfig.json`
- Create: `PolarUI/templates/native-web/apps/api/src/app.ts`
- Create: `PolarUI/templates/native-web/apps/api/src/server.ts`
- Create: `PolarUI/templates/native-web/apps/api/tests/app.test.ts`

- [ ] **Step 1: Write failing API tests**

Create `PolarUI/templates/native-web/apps/api/tests/app.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const manifest = {
  contract_version: '1.0',
  product: { id: 'demo', name: 'Demo', context_label: '情境', route_label: '路线' },
  workflow: { id: 'demo', endpoint: 'http://127.0.0.1:8065/run/demo/flow.json' },
  stages: [{ key: 'work', label: '开始工作', component_key: 'generic_chat', internal_states: ['start'], actions: [] }],
};

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe('native API', () => {
  it('reports health without exposing workflow internals', async () => {
    const app = buildApp({ manifest, staticRoot: null });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: 'polar-web' });
  });

  it('returns the validated product manifest', async () => {
    const app = buildApp({ manifest, staticRoot: null });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(response.statusCode).toBe(200);
    expect(response.json().manifest.product.id).toBe('demo');
  });

  it('rejects an invalid manifest at startup', () => {
    expect(() => buildApp({ manifest: { ...manifest, stages: [] }, staticRoot: null })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd ~/Polarisor/PolarUI/templates/native-web
npm run test -w @polar/native-web-api
```

Expected: FAIL because the API package does not exist.

- [ ] **Step 3: Create API package metadata**

Create `PolarUI/templates/native-web/apps/api/package.json`:

```json
{
  "name": "@polar/native-web-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/server.ts",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/static": "^8.2.0",
    "@polar/native-web-product-sdk": "0.1.0",
    "fastify": "^5.4.0"
  },
  "devDependencies": {
    "tsx": "^4.20.0",
    "typescript": "^5.7.0",
    "vitest": "^3.2.0"
  }
}
```

Create `PolarUI/templates/native-web/apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Implement the Fastify application**

Create `PolarUI/templates/native-web/apps/api/src/app.ts`:

```ts
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { parseProductManifest, type ProductManifest } from '@polar/native-web-product-sdk';

export function buildApp(options: { manifest: unknown; staticRoot: string | null }) {
  const manifest: ProductManifest = parseProductManifest(options.manifest);
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true, service: 'polar-web' }));
  app.get('/api/bootstrap', async () => ({ manifest }));

  if (options.staticRoot) {
    app.register(fastifyStatic, { root: options.staticRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
```

Create `PolarUI/templates/native-web/apps/api/src/server.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const manifestPath = process.env.PRODUCT_MANIFEST_PATH ?? join(root, 'product.manifest.json');
const staticRoot = process.env.WEB_STATIC_ROOT ?? join(root, 'apps/web/dist');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const app = buildApp({ manifest, staticRoot });
const port = Number(process.env.PORT ?? 3920);

await app.listen({ host: '0.0.0.0', port });
```

- [ ] **Step 5: Install, test, and build the API**

Run:

```bash
cd ~/Polarisor/PolarUI/templates/native-web
npm install
npm run test -w @polar/native-web-api
npm run build -w @polar/native-web-api
```

Expected: 3 tests PASS and `apps/api/dist/server.js` exists.

- [ ] **Step 6: Main Agent review and checkpoint commit**

The Main Agent reviews the task diff, reruns the API tests, and then runs:

```bash
cd ~/Polarisor
git add PolarUI/templates/native-web/apps/api PolarUI/templates/native-web/package-lock.json
git commit -m "feat(polarui): serve native product bootstrap"
```

## Task 4: Build the fixed minimal React product shell

**Files:**
- Modify: `PolarUI/templates/native-web/package-lock.json`
- Create: `PolarUI/templates/native-web/apps/web/package.json`
- Create: `PolarUI/templates/native-web/apps/web/tsconfig.json`
- Create: `PolarUI/templates/native-web/apps/web/vite.config.ts`
- Create: `PolarUI/templates/native-web/apps/web/index.html`
- Create: `PolarUI/templates/native-web/apps/web/src/main.tsx`
- Create: `PolarUI/templates/native-web/apps/web/src/App.tsx`
- Create: `PolarUI/templates/native-web/apps/web/src/styles.css`
- Create: `PolarUI/templates/native-web/apps/web/src/App.test.tsx`
- Create: `PolarUI/templates/native-web/apps/web/src/test-setup.ts`

- [ ] **Step 1: Write failing shell tests**

Create `PolarUI/templates/native-web/apps/web/src/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App';

const manifest = {
  contract_version: '1.0' as const,
  product: { id: 'demo', name: 'Workflow Workspace', context_label: '情境', route_label: '路线' },
  workflow: { id: 'demo', endpoint: 'http://127.0.0.1:8065/run/demo/flow.json' },
  stages: [
    { key: 'discover', label: '发现', component_key: 'generic_chat' as const, internal_states: ['start'], actions: [] },
    { key: 'decide', label: '决策', component_key: 'document_workspace' as const, internal_states: ['decide'], actions: [] },
  ],
};

describe('App', () => {
  it('renders the four fixed shell slots', () => {
    render(<App manifest={manifest} />);
    expect(screen.getByTestId('product-bar')).toBeInTheDocument();
    expect(screen.getByTestId('navigator-slot')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-slot')).toBeInTheDocument();
    expect(screen.getByTestId('thread-slot')).toBeInTheDocument();
  });

  it('allows free stage navigation without changing workflow state', async () => {
    render(<App manifest={manifest} />);
    await userEvent.click(screen.getByRole('button', { name: '决策' }));
    expect(screen.getByRole('heading', { name: '决策' })).toBeInTheDocument();
    expect(screen.getByText('document_workspace')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
cd ~/Polarisor/PolarUI/templates/native-web
npm run test -w @polar/native-web-web
```

Expected: FAIL because the web package does not exist.

- [ ] **Step 3: Create the web package configuration**

Create `PolarUI/templates/native-web/apps/web/package.json`:

```json
{
  "name": "@polar/native-web-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "test": "vitest run"
  },
  "dependencies": {
    "@polar/native-web-product-sdk": "0.1.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.5.0",
    "jsdom": "^26.1.0",
    "typescript": "^5.7.0",
    "vite": "^6.3.0",
    "vitest": "^3.2.0"
  }
}
```

Create `PolarUI/templates/native-web/apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "noEmit": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
}
```

Create `PolarUI/templates/native-web/apps/web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
```

Create `PolarUI/templates/native-web/apps/web/src/test-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

Create `PolarUI/templates/native-web/apps/web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Workflow Workspace</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Implement the fixed shell**

Create `PolarUI/templates/native-web/apps/web/src/App.tsx`:

```tsx
import { useState } from 'react';
import type { ProductManifest } from '@polar/native-web-product-sdk';

export function App({ manifest }: { manifest: ProductManifest }) {
  const [stageKey, setStageKey] = useState(manifest.stages[0].key);
  const stage = manifest.stages.find((item) => item.key === stageKey) ?? manifest.stages[0];

  return (
    <div className="app-shell">
      <header className="product-bar" data-testid="product-bar">
        <strong>{manifest.product.name}</strong>
        <span>{manifest.workflow.id}</span>
      </header>
      <aside className="navigator" data-testid="navigator-slot">
        <p className="eyebrow">{manifest.product.context_label}</p>
        <div className="context-card">默认{manifest.product.context_label}</div>
        <p className="eyebrow">阶段</p>
        <nav aria-label="阶段导航">
          {manifest.stages.map((item) => (
            <button
              className={item.key === stage.key ? 'stage-link active' : 'stage-link'}
              key={item.key}
              onClick={() => setStageKey(item.key)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="workspace" data-testid="workspace-slot">
        <p className="eyebrow">Stage Workspace</p>
        <h1>{stage.label}</h1>
        <p className="component-key">{stage.component_key}</p>
        <div className="workspace-card">阶段专属组件将在发行版中注册。</div>
      </main>
      <aside className="threads" data-testid="thread-slot">
        <p className="eyebrow">Threads</p>
        <button type="button" className="thread-card">主线讨论</button>
        <button type="button" className="thread-card">＋ 新建线程</button>
      </aside>
    </div>
  );
}
```

Create `PolarUI/templates/native-web/apps/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseProductManifest } from '@polar/native-web-product-sdk';
import { App } from './App';
import './styles.css';

const response = await fetch('/api/bootstrap');
if (!response.ok) throw new Error(`bootstrap failed: ${response.status}`);
const body = await response.json();
const manifest = parseProductManifest(body.manifest);

createRoot(document.getElementById('root')!).render(
  <StrictMode><App manifest={manifest} /></StrictMode>,
);
```

Create `PolarUI/templates/native-web/apps/web/src/styles.css`:

```css
:root {
  color: #17211d;
  background: #f4f5f1;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
button { font: inherit; }
.app-shell { min-height: 100vh; display: grid; grid-template: 56px 1fr / 240px minmax(0, 1fr) 300px; }
.product-bar { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; padding: 0 22px; border-bottom: 1px solid #d8ddd7; background: #ffffff; }
.navigator, .threads { padding: 20px 16px; background: #edf0ea; }
.navigator { border-right: 1px solid #d8ddd7; }
.threads { border-left: 1px solid #d8ddd7; }
.workspace { padding: 36px; background: #fafaf7; }
.eyebrow { margin: 0 0 10px; color: #69736d; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
.context-card, .workspace-card, .thread-card { width: 100%; padding: 14px; border: 1px solid #d8ddd7; border-radius: 12px; background: #ffffff; color: inherit; text-align: left; }
.stage-link { width: 100%; margin: 4px 0; padding: 10px 12px; border: 0; border-radius: 9px; background: transparent; color: #45514a; text-align: left; cursor: pointer; }
.stage-link.active { background: #173f35; color: #ffffff; }
.thread-card { margin-bottom: 8px; cursor: pointer; }
.component-key { color: #8a5a2b; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
@media (max-width: 900px) {
  .app-shell { grid-template: 56px auto 1fr auto / 1fr; }
  .product-bar { grid-column: 1; }
  .navigator, .threads { border: 0; }
  .workspace { padding: 24px 18px; }
}
```

- [ ] **Step 5: Install, test, and build the web shell**

Run:

```bash
cd ~/Polarisor/PolarUI/templates/native-web
npm install
npm run test -w @polar/native-web-web
npm run build -w @polar/native-web-web
```

Expected: 2 tests PASS and `apps/web/dist/index.html` exists.

- [ ] **Step 6: Main Agent review and checkpoint commit**

The Main Agent reviews the task diff, reruns the web tests, and then runs:

```bash
cd ~/Polarisor
git add PolarUI/templates/native-web/apps/web PolarUI/templates/native-web/package-lock.json
git commit -m "feat(polarui): add fixed native workflow product shell"
```

## Task 5: Build and smoke-test the single public container

**Files:**
- Create: `PolarUI/templates/native-web/Dockerfile`
- Create: `PolarUI/templates/native-web/compose.yml`
- Create: `PolarUI/templates/native-web/.dockerignore`
- Modify: `PolarUI/templates/native-web/README.md`

- [ ] **Step 1: Add a failing production build check**

Run before creating the Dockerfile:

```bash
cd ~/Polarisor/PolarUI/templates/native-web
docker build -t polar-native-web:phase1 .
```

Expected: FAIL with `failed to read dockerfile`.

- [ ] **Step 2: Create the multi-stage Dockerfile**

Create `PolarUI/templates/native-web/Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/product-sdk/package.json packages/product-sdk/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci
COPY packages ./packages
COPY apps ./apps
COPY product.manifest.json ./product.manifest.json
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/product-sdk/package.json packages/product-sdk/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @polar/native-web-api --workspace @polar/native-web-product-sdk
COPY --from=build /app/packages/product-sdk/dist ./packages/product-sdk/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY product.manifest.json ./product.manifest.json
EXPOSE 3920
CMD ["node", "apps/api/dist/server.js"]
```

Create `PolarUI/templates/native-web/.dockerignore`:

```text
node_modules
**/node_modules
**/dist
.git
test-results
playwright-report
```

Create `PolarUI/templates/native-web/compose.yml`:

```yaml
services:
  web:
    build: .
    environment:
      PORT: 3920
    ports:
      - "3920:3920"
```

- [ ] **Step 3: Build and start the real image**

Run:

```bash
cd ~/Polarisor/PolarUI/templates/native-web
docker build -t polar-native-web:phase1 .
docker run --rm -d --name polar-native-web-phase1 -p 3920:3920 polar-native-web:phase1
curl -fsS http://127.0.0.1:3920/healthz
curl -fsS http://127.0.0.1:3920/api/bootstrap
```

Expected: health returns `{"ok":true,"service":"polar-web"}` and bootstrap contains `"native-web-template"`.

- [ ] **Step 4: Verify the actual HTML has no LibreChat branding**

Run:

```bash
curl -fsS http://127.0.0.1:3920/ | rg 'Workflow Workspace'
if curl -fsS http://127.0.0.1:3920/ | rg -i 'LibreChat'; then exit 1; fi
docker stop polar-native-web-phase1
```

Expected: title match succeeds; LibreChat check produces no match; container stops cleanly.

- [ ] **Step 5: Document production-like local launch**

Append to `PolarUI/templates/native-web/README.md`:

````md
## Production-like container

```bash
docker compose up --build
curl -fsS http://127.0.0.1:3920/healthz
```

The image exposes one public service. PostgreSQL, authentication, workflow execution, and artifact storage are outside the Phase 1 scope and receive separate implementation plans.
````

- [ ] **Step 6: Main Agent review and checkpoint commit**

The Main Agent reviews the task diff, reruns the container smoke test, and then runs:

```bash
cd ~/Polarisor
git add PolarUI/templates/native-web/Dockerfile PolarUI/templates/native-web/compose.yml PolarUI/templates/native-web/.dockerignore PolarUI/templates/native-web/README.md
git commit -m "feat(polarui): package native workflow shell container"
```

## Task 6: Compile workflow product manifests for native exports

**Files:**
- Create: `PolarUI/scripts/compile-product-manifest.mjs`
- Create: `PolarUI/scripts/compile-product-manifest.test.mjs`
- Create: `PolarUI/workflows/claude-code/product.manifest.json`

- [ ] **Step 1: Write failing compiler tests**

Create `PolarUI/scripts/compile-product-manifest.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileProductManifest } from './compile-product-manifest.mjs';

test('loads a workflow product manifest and injects release identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'product-manifest-'));
  mkdirSync(join(root, 'workflow'), { recursive: true });
  writeFileSync(join(root, 'workflow/product.manifest.json'), JSON.stringify({
    contract_version: '1.0',
    product: { id: 'claude-code', name: 'Claude Code', context_label: '项目', route_label: '路线' },
    workflow: { id: 'source-workflow', endpoint: 'http://127.0.0.1:8065/run/source-workflow/flow.json' },
    stages: [{ key: 'work', label: '工作', component_key: 'generic_chat', internal_states: ['start'], actions: [] }],
  }));
  const result = await compileProductManifest({
    workflowDir: join(root, 'workflow'),
    workflowId: 'claude-code',
    releaseId: 'claude-code_2',
  });
  assert.equal(result.workflow.id, 'claude-code');
  assert.equal(result.product.id, 'claude-code-2');
  assert.match(result.workflow.endpoint, /claude-code\/flow\.json$/);
});

test('rejects recursive layout keys before export', async () => {
  const root = mkdtempSync(join(tmpdir(), 'product-manifest-bad-'));
  mkdirSync(join(root, 'workflow'), { recursive: true });
  writeFileSync(join(root, 'workflow/product.manifest.json'), JSON.stringify({ layout: { children: [] } }));
  await assert.rejects(
    compileProductManifest({ workflowDir: join(root, 'workflow'), workflowId: 'bad', releaseId: 'bad' }),
  );
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
cd ~/Polarisor/PolarUI
node --test scripts/compile-product-manifest.test.mjs
```

Expected: FAIL because the compiler does not exist.

- [ ] **Step 3: Implement compiler validation using the tracked SDK**

Create `PolarUI/scripts/compile-product-manifest.mjs`:

```js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

let parserPromise;
async function loadParser() {
  const templateRoot = join(import.meta.dirname, '../templates/native-web');
  const sdkEntry = join(templateRoot, 'packages/product-sdk/dist/index.js');
  if (!existsSync(sdkEntry)) {
    const install = spawnSync('npm', ['install'], { cwd: templateRoot, stdio: 'inherit' });
    if (install.status !== 0) throw new Error('native template npm install failed');
    const build = spawnSync(
      'npm',
      ['run', 'build', '-w', '@polar/native-web-product-sdk'],
      { cwd: templateRoot, stdio: 'inherit' },
    );
    if (build.status !== 0) throw new Error('native product SDK build failed');
  }
  parserPromise ??= import(pathToFileURL(sdkEntry).href);
  return parserPromise;
}

export async function compileProductManifest({ workflowDir, workflowId, releaseId }) {
  const raw = JSON.parse(readFileSync(join(workflowDir, 'product.manifest.json'), 'utf8'));
  const normalized = {
    ...raw,
    product: { ...raw.product, id: releaseId.replace(/_/g, '-') },
    workflow: {
      ...raw.workflow,
      id: workflowId,
      endpoint: `http://127.0.0.1:8065/run/${workflowId}/flow.json`,
    },
  };
  const { parseProductManifest } = await loadParser();
  return parseProductManifest(normalized);
}
```

Create `PolarUI/workflows/claude-code/product.manifest.json`:

```json
{
  "contract_version": "1.0",
  "product": {
    "id": "claude-code",
    "name": "Claude Code Workspace",
    "context_label": "项目",
    "route_label": "路线"
  },
  "workflow": {
    "id": "claude-code",
    "endpoint": "http://127.0.0.1:8065/run/claude-code/flow.json"
  },
  "stages": [
    {
      "key": "work",
      "label": "项目工作",
      "component_key": "generic_chat",
      "internal_states": ["start", "running", "done"],
      "actions": []
    }
  ]
}
```

- [ ] **Step 4: Build SDK and run compiler tests**

Run:

```bash
cd ~/Polarisor/PolarUI/templates/native-web
npm run build -w @polar/native-web-product-sdk
cd ~/Polarisor/PolarUI
node --test scripts/compile-product-manifest.test.mjs
```

Expected: 2 tests PASS.

- [ ] **Step 5: Main Agent review and checkpoint commit**

The Main Agent reviews the task diff, reruns the manifest compiler tests, and then runs:

```bash
cd ~/Polarisor
git add PolarUI/scripts/compile-product-manifest.mjs PolarUI/scripts/compile-product-manifest.test.mjs PolarUI/workflows/claude-code/product.manifest.json
git commit -m "feat(polarui): compile workflow product manifests"
```

## Task 7: Add the opt-in native export flavor

**Files:**
- Modify: `PolarUI/scripts/export-release.mjs`
- Modify: `PolarUI/scripts/export-release.test.mjs`
- Modify: `PolarUI/scripts/compile-site-config.mjs`
- Modify: `PolarUI/scripts/compile-site-config.test.mjs`

- [ ] **Step 1: Add failing native export assertions**

Add to `PolarUI/scripts/export-release.test.mjs`:

```js
test('native export contains polar-web and excludes LibreChat runtime', async () => {
  const r = await exportRelease({
    workflow: WORKFLOW_ID,
    webRoot: TEST_ROOT,
    templateFlavor: 'native',
    skipPreflight: true,
    compileOnly: true,
    silent: true,
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.manifest.template_flavor, 'native');
  assert.ok(existsSync(join(r.release_path, 'product.manifest.json')));
  assert.ok(existsSync(join(r.release_path, 'Dockerfile')));
  assert.equal(existsSync(join(r.release_path, 'librechat.yaml')), false);
  assert.equal(existsSync(join(r.release_path, 'upstream/librechat')), false);
  rmSync(r.release_path, { recursive: true, force: true });
});
```

Add to `PolarUI/scripts/compile-site-config.test.mjs`:

```js
test('native config exposes one web port and no librechat port', () => {
  const opts = baseOpts({
    templateFlavor: 'native',
  });
  try {
    const result = compileSiteConfig(opts);
    assert.equal(result.manifest.template_flavor, 'native');
    assert.equal(result.config.preferred_web_port, 3920);
    assert.equal('preferred_lc_port' in result.config, false);
  } finally {
    opts._cleanup();
  }
});
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run:

```bash
cd ~/Polarisor/PolarUI
node --test --test-name-pattern='native export|native config' scripts/export-release.test.mjs scripts/compile-site-config.test.mjs
```

Expected: FAIL because native flavor is not handled.

- [ ] **Step 3: Extend argument parsing and template resolution**

In `PolarUI/scripts/export-release.mjs`:

1. import `resolveTemplateSource` from `./native-template.mjs`;
2. import `compileProductManifest` from `./compile-product-manifest.mjs`;
3. add `templateFlavor: 'legacy'` to `parseArgs`;
4. parse `--template-flavor native|legacy`;
5. set:

```js
const templateFlavor = opts.templateFlavor ?? 'legacy';
const templateDir = opts.templateDir ?? resolveTemplateSource({
  flavor: templateFlavor,
  polaruiRoot: POLARUI_ROOT,
  webRoot,
});
```

After the config step and before verification, add a native-only step:

```js
if (templateFlavor === 'native') {
  await runStep(log, 8.5, 'product-manifest', 'compileProductManifest', async () => {
    const productManifest = await compileProductManifest({ workflowDir, workflowId, releaseId });
    writeFileSync(
      join(stagingRoot, 'product.manifest.json'),
      JSON.stringify(productManifest, null, 2),
    );
    return 'product.manifest.json';
  });
}
```

Replace the current patch step with this flavor guard; keep the legacy body inside the legacy branch:

```js
if (templateFlavor === 'legacy') {
  await runStep(log, 9, 'patch', 'patchLibreChat (polar/injected + http modelSpecs)', () => {
    mkdirSync(join(stagingRoot, 'polar/injected'), { recursive: true });
    writeFileSync(
      join(stagingRoot, 'polar/injected/release.json'),
      JSON.stringify({ release_id: releaseId, workflow_id: workflowId }, null, 2),
    );
    const readmePath = join(stagingRoot, 'README.md');
    if (existsSync(readmePath)) {
      const readme = readFileSync(readmePath, 'utf8');
      if (!readme.includes(releaseId)) {
        writeFileSync(readmePath, `${readme}\n\n## Release\n\n- **release_id**: \`${releaseId}\`\n`);
      }
    }
    let patchDetail = 'polar/injected/release.json';
    const lcYamlPath = join(stagingRoot, 'librechat.yaml');
    if (httpWorkflows.length > 0 && existsSync(lcYamlPath)) {
      const patched = patchLibreChatHttpWorkflows(readFileSync(lcYamlPath, 'utf8'), httpWorkflows);
      writeFileSync(lcYamlPath, patched.yaml);
      patchDetail += ` + modelSpecs(+${patched.added})`;
    }
    return patchDetail;
  });
} else {
  log.record({ index: 9, id: 'patch', title: 'legacy patch', status: 'skip', ms: 0, detail: 'native template' });
}
```

Pass `templateFlavor` to `compileSiteConfig`, include it in the success result, and update CLI usage text to document `--template-flavor native|legacy`.

- [ ] **Step 4: Emit flavor-specific site configuration**

In `PolarUI/scripts/compile-site-config.mjs`, accept `templateFlavor = 'legacy'`, add `template_flavor` to the manifest, and replace the current config literal with:

```js
const common = {
  release_id: releaseId,
  workflow_id: workflowId,
  template_flavor: templateFlavor,
  engine: 'polarflow',
  polarflow: {
    api_url_env: 'WORKFLOW_ENGINE_URL',
    default_api_url: 'http://127.0.0.1:8065',
    flow_path: `${workflowId}/flow.json`,
  },
  port: null,
  registry: registry ?? {},
  required_executors: requiredExecutors ?? [],
  memory_schema: memorySchemaRel,
};

const config = templateFlavor === 'native'
  ? {
      ...common,
      preferred_web_port: 3920,
    }
  : {
      ...common,
      polarflow: {
        ...common.polarflow,
        host_api_url: 'http://127.0.0.1:8065',
      },
      preferred_api_port: 3920,
      preferred_lc_port: 3080,
      librechat_port: null,
    };
```

After constructing `config`, keep the existing `normalizeHttpWorkflows` merge so both flavors can carry registered HTTP workflow declarations.

- [ ] **Step 5: Run exporter tests**

Run:

```bash
cd ~/Polarisor/PolarUI
node --test scripts/native-template.test.mjs scripts/compile-product-manifest.test.mjs scripts/compile-site-config.test.mjs scripts/export-release.test.mjs
```

Expected: all tests PASS; native release has no `librechat.yaml` or `upstream/librechat`.

- [ ] **Step 6: Main Agent review and checkpoint commit**

The Main Agent reviews the task diff, reruns the native export tests, and then runs:

```bash
cd ~/Polarisor
git add PolarUI/scripts/export-release.mjs PolarUI/scripts/export-release.test.mjs PolarUI/scripts/compile-site-config.mjs PolarUI/scripts/compile-site-config.test.mjs
git commit -m "feat(polarui): add native workflow web export flavor"
```

## Task 8: Make release verification and deployment flavor-aware

**Files:**
- Modify: `PolarUI/scripts/verify-release.mjs`
- Create: `PolarUI/scripts/verify-release.test.mjs`
- Modify: `PolarUI/scripts/deploy-web-release.mjs`
- Modify: `PolarUI/scripts/export-release.mjs`

- [ ] **Step 1: Write failing native verification tests**

Create `PolarUI/scripts/verify-release.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyRelease } from './verify-release.mjs';

function nativeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-release-'));
  mkdirSync(join(root, 'workflow'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  const snapshot = '{}';
  writeFileSync(join(root, 'workflow/snapshot.json'), snapshot);
  writeFileSync(join(root, 'config/memory-schema.json'), '{}');
  writeFileSync(join(root, 'config/required-executors.json'), '{"executors":["LLM"]}');
  writeFileSync(join(root, 'site.config.json'), '{"template_flavor":"native"}');
  writeFileSync(join(root, 'product.manifest.json'), '{"contract_version":"1.0"}');
  writeFileSync(join(root, 'Dockerfile'), 'FROM node:22-alpine\n');
  writeFileSync(join(root, 'README.md'), '# Native\n');
  writeFileSync(join(root, 'EXPORT.log'), 'ok\n');
  writeFileSync(join(root, 'site.manifest.json'), JSON.stringify({
    release_id: 'native', workflow_id: 'demo', template_flavor: 'native',
    workflow_snapshot: 'workflow/snapshot.json',
    workflow_checksum: `sha256:${createHash('sha256').update(snapshot).digest('hex')}`,
    compile_steps: ['a', 'b', 'c', 'd', 'e', 'f'],
  }));
  return root;
}

test('native verification requires product manifest and Dockerfile', () => {
  const root = nativeFixture();
  assert.equal(verifyRelease(root).ok, true);
});

test('native verification rejects LibreChat runtime files', () => {
  const root = nativeFixture();
  writeFileSync(join(root, 'librechat.yaml'), 'version: 1\n');
  const result = verifyRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('librechat.yaml')));
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
cd ~/Polarisor/PolarUI
node --test scripts/verify-release.test.mjs
```

Expected: the second test FAILS because legacy files are not rejected.

- [ ] **Step 3: Implement flavor-specific verification**

In `PolarUI/scripts/verify-release.mjs`:

1. parse `site.manifest.json` before building the required-file list;
2. for `template_flavor === 'native'`, require `product.manifest.json` and `Dockerfile`;
3. reject `librechat.yaml`, `upstream/librechat`, and `scripts/build-librechat.mjs`;
4. for legacy releases, keep the existing required list and compatibility behavior.

Use these constants:

```js
const NATIVE_REQUIRED = ['product.manifest.json', 'Dockerfile'];
const NATIVE_FORBIDDEN = ['librechat.yaml', 'upstream/librechat', 'scripts/build-librechat.mjs'];
```

- [ ] **Step 4: Make deployment use one public native service**

In `PolarUI/scripts/deploy-web-release.mjs`, extract the PolarProcess request into this helper:

```js
async function registerAndStartService(serviceBody) {
  const response = await fetch(`${POLARPROCESS_URL}/api/services/register-and-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serviceBody),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(`PolarProcess register-and-start failed: ${body.message ?? response.status}`);
  }
  return body;
}
```

Immediately after reading `site.config.json`, add the complete native branch below. Leave the existing legacy allocation and return path after this branch, replacing its inline PolarProcess request with `registerAndStartService(serviceBody)`.

```js
if (config.template_flavor === 'native') {
  const webService = `web-${releaseId}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48);
  const containerName = `${webService}-container`.slice(0, 63);
  const imageTag = `polar-native-${releaseId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}:latest`;
  let webPort = null;
  try {
    const build = spawnSync('docker', ['build', '-t', imageTag, '.'], {
      cwd: releaseRoot,
      stdio: 'inherit',
    });
    if (build.status !== 0) throw new Error('native web docker build failed');
    webPort = await claimPolarPort({
      serviceName: webService,
      project: 'PolarUI',
      preferred: config.preferred_web_port ?? 3920,
    });
    const serviceBody = {
      id: webService,
      name: `Web ${releaseId}`,
      command: [
        'docker run --rm',
        `--name ${shellQuote(containerName)}`,
        `-p 127.0.0.1:${webPort}:3920`,
        shellQuote(imageTag),
      ].join(' '),
      work_dir: releaseRoot,
      port: webPort,
      health_check_url: `http://127.0.0.1:${webPort}/healthz`,
      auto_start: true,
      restart_on_failure: true,
      max_restarts: 5,
      device_id: 'any',
    };
    const start = await registerAndStartService(serviceBody);
    config.port = webPort;
    config.polarport = {
      web_service: webService,
      allocated_at: new Date().toISOString(),
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const deploy = {
      web_port: webPort,
      web_url: `http://127.0.0.1:${webPort}/`,
      service_id: webService,
    };
    mkdirSync(join(releaseRoot, 'injected'), { recursive: true });
    writeFileSync(join(releaseRoot, 'injected/deploy.json'), JSON.stringify(deploy, null, 2));
    return { ok: true, ...deploy, start };
  } catch (error) {
    await releasePolarPort(webPort);
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    spawnSync('docker', ['rmi', '-f', imageTag], { stdio: 'ignore' });
    throw error;
  }
}
```

Add `mkdirSync` to the existing `node:fs` import and `spawnSync` from `node:child_process`. Do not allocate an LC port for native releases.

In the deploy step of `PolarUI/scripts/export-release.mjs`, replace the legacy-only detail string with:

```js
return templateFlavor === 'native'
  ? `web=${deploy.web_port} service=${deploy.service_id}`
  : `api=${deploy.api_port} lc=${deploy.librechat_port ?? 'n/a'} service=${deploy.service_id}`;
```

- [ ] **Step 5: Run verification and export tests**

Run:

```bash
cd ~/Polarisor/PolarUI
node --test scripts/verify-release.test.mjs scripts/export-release.test.mjs scripts/compile-site-config.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 6: Main Agent review and checkpoint commit**

The Main Agent reviews the task diff, reruns the complete Task 8 acceptance command from Step 5, and then runs:

```bash
cd ~/Polarisor
git add PolarUI/scripts/verify-release.mjs PolarUI/scripts/verify-release.test.mjs PolarUI/scripts/deploy-web-release.mjs PolarUI/scripts/export-release.mjs
git commit -m "feat(polarui): verify and deploy native web releases"
```

## Task 9: Add real-container browser QA for native exports

**Files:**
- Create: `PolarUI/scripts/qa-native-web-release.mjs`
- Modify: `PolarUI/package.json`
- Modify: `PolarUI/docs/WEB_EXPORT.md`

- [ ] **Step 1: Create the QA script with explicit release checks**

Create `PolarUI/scripts/qa-native-web-release.mjs`:

```js
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { exportRelease } from './export-release.mjs';

const root = mkdtempSync(join(tmpdir(), 'polar-native-qa-'));
const image = `polar-native-qa:${Date.now()}`;
const container = `polar-native-qa-${process.pid}`;
const port = 3990;

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`health timeout: ${url}`);
}

try {
  const result = await exportRelease({
    workflow: 'claude-code',
    webRoot: root,
    templateFlavor: 'native',
    skipPreflight: true,
    compileOnly: true,
    silent: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));

  const build = spawnSync('docker', ['build', '-t', image, '.'], {
    cwd: result.release_path,
    stdio: 'inherit',
  });
  if (build.status !== 0) throw new Error('docker build failed');

  const run = spawnSync('docker', [
    'run', '--rm', '-d', '--name', container, '-p', `${port}:3920`, image,
  ], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error('docker run failed');

  await waitForHealth(`http://127.0.0.1:${port}/healthz`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.getByTestId('product-bar').waitFor();
  await page.getByRole('button', { name: '项目工作' }).click();
  if (await page.getByText(/LibreChat/i).count()) throw new Error('LibreChat text visible');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('workspace-slot').waitFor();
  await browser.close();
  console.log('[QA PASS] native export production container');
} finally {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  spawnSync('docker', ['rmi', '-f', image], { stdio: 'ignore' });
  rmSync(root, { recursive: true, force: true });
}
```

- [ ] **Step 2: Add package scripts**

In `PolarUI/package.json`, add:

```json
{
  "scripts": {
    "test:native-web": "node --test scripts/native-template.test.mjs scripts/compile-product-manifest.test.mjs scripts/verify-release.test.mjs && npm test --prefix templates/native-web",
    "qa:native-web": "node scripts/qa-native-web-release.mjs"
  }
}
```

Merge these keys into the existing `scripts` object; do not replace other scripts.

- [ ] **Step 3: Document the opt-in native export**

Add to `PolarUI/docs/WEB_EXPORT.md`:

````md
## Native workflow web template — Phase 1

The native template is opt-in during Phase 1. Authentication, PostgreSQL persistence, workflow lineage, and legacy migration are specified in separate follow-on plans.

```bash
node scripts/export-release.mjs \
  --workflow claude-code \
  --template-flavor native \
  --compile-only \
  --skip-preflight
```

A native release contains one `polar-web` application and no LibreChat runtime. Do not make native the default until the Phase 2–5 persistence, workflow, migration, and release gates are complete.
````

- [ ] **Step 4: Run the complete Phase 1 test suite**

Run:

```bash
cd ~/Polarisor/PolarUI
npm run test:native-web
node --test scripts/compile-site-config.test.mjs scripts/export-release.test.mjs
npm run qa:native-web
```

Expected:

- all native unit and exporter tests PASS;
- Docker image builds;
- Playwright verifies 1440px and 390px layouts on port 3990;
- output ends with `[QA PASS] native export production container`.

- [ ] **Step 5: Check release boundaries**

Run:

```bash
cd ~/Polarisor/PolarUI
rg -n -i 'LibreChat|@polar.local|build-librechat|upstream/librechat' templates/native-web scripts/qa-native-web-release.mjs
```

Expected: no matches in `templates/native-web`; the QA script may contain only the negative assertion string `LibreChat`.

- [ ] **Step 6: Main Agent review and checkpoint commit**

The Main Agent reviews the task diff, reruns the real-container browser QA, and then runs:

```bash
cd ~/Polarisor
git add PolarUI/scripts/qa-native-web-release.mjs PolarUI/package.json PolarUI/docs/WEB_EXPORT.md
git commit -m "test(polarui): gate native web release container"
```

## Task 10: Phase 1 final verification and handoff

**Execution owner:** Main Agent only. Do not delegate any step in this task.

**Files:**
- Verify only; modify files only if a preceding command exposes a defect.

- [ ] **Step 1: Run formatting-independent checks**

```bash
cd ~/Polarisor
git diff --check
node --check PolarUI/scripts/export-release.mjs
node --check PolarUI/scripts/deploy-web-release.mjs
node --check PolarUI/scripts/qa-native-web-release.mjs
```

Expected: all commands exit 0.

- [ ] **Step 2: Run Phase 1 unit and exporter verification**

```bash
cd ~/Polarisor/PolarUI
npm run test:native-web
node --test scripts/compile-site-config.test.mjs scripts/export-release.test.mjs
```

Expected: all tests PASS with zero failures.

- [ ] **Step 3: Run actual-container QA again**

```bash
cd ~/Polarisor/PolarUI
npm run qa:native-web
```

Expected: `[QA PASS] native export production container`.

- [ ] **Step 4: Confirm the legacy path remains available**

```bash
cd ~/Polarisor/PolarUI
node --test --test-name-pattern='legacy flavor|AC-R01|P2a' scripts/native-template.test.mjs scripts/export-release.test.mjs
```

Expected: selected legacy compatibility tests PASS. Phase 1 must not change the current default export flavor.

- [ ] **Step 5: Confirm repository state and record the next plans**

```bash
cd ~/Polarisor
git status --short
git log --oneline -10
```

Expected: no uncommitted Phase 1 files. Existing unrelated user changes may remain and must not be staged.

The next plans, in order, are:

1. identity + PostgreSQL persistence;
2. Context/Route/Stage/Thread/Checkpoint domain and APIs;
3. Workflow Bridge, SSE, command idempotency, and controlled adoption/fork actions;
4. artifact storage and fixed component registry expansion;
5. LibreChat read-only importer, export-default cutover, and full Mailpit/browser release gates.
