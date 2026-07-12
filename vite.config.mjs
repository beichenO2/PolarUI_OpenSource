/**
 * PolarUI dev server — serves dist/ with API proxies.
 * - /api/polaris/* → local polaris.json (Hub 未启动时) 或 Hub :8040
 * - /api/services, /api/watchdog → PolarProcess :11055（避免 CORS）
 */
import { defineConfig } from 'vite';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLARUI_ROOT = __dirname;
const HUB = process.env.POLAR_HUB_URL ?? 'http://127.0.0.1:8040';
const POLAR_PROCESS = process.env.POLAR_PROCESS_URL ?? 'http://127.0.0.1:11055';

function exportReleaseMiddleware() {
  return {
    name: 'export-release-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/api/export-release' || req.method !== 'POST') return next();
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            const { exportRelease } = await import('./scripts/export-release.mjs');
            const result = await exportRelease({
              workflow: body.workflow_id,
              fromRelease: body.from_release,
              skipPreflight: body.skip_preflight,
              compileOnly: body.compile_only,
              exportEntry: 'gui',
              json: false,
            });
            res.setHeader('Content-Type', 'application/json');
            const STAGE_STATUS = { input: 400, preflight: 412 };
            res.statusCode = result.ok ? 200 : (STAGE_STATUS[result.stage] ?? 500);
            res.end(JSON.stringify(result));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}

function polarisDevMiddleware() {
  return {
    name: 'polaris-dev-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/api\/polaris\/([^/?]+)$/);
        if (!m || req.method !== 'GET') return next();

        const project = decodeURIComponent(m[1]);
        const localPath = join(POLARUI_ROOT, project === 'PolarUI' ? 'polaris.json' : `../${project}/polaris.json`);

        if (existsSync(localPath)) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(readFileSync(localPath));
          return;
        }
        next();
      });
    },
  };
}

function nodeDefsDevMiddleware() {
  const nodeDefsRoot = join(POLARUI_ROOT, 'node-defs');
  return {
    name: 'node-defs-ssot',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/node-defs\/(.+)$/);
        if (!m || req.method !== 'GET') return next();
        const rel = decodeURIComponent(m[1].split('?')[0]);
        const filePath = join(nodeDefsRoot, rel);
        if (!existsSync(filePath) || !filePath.startsWith(nodeDefsRoot)) return next();
        const type = rel.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
        res.setHeader('Content-Type', type);
        res.end(readFileSync(filePath));
      });
    },
  };
}

export default defineConfig({
  root: join(POLARUI_ROOT, 'dist'),
  // `vite preview` serves build.outDir (resolved against root). dist/ IS the
  // prebuilt app here, so point outDir at root itself or preview 404s (dist/dist).
  build: { outDir: '.', emptyOutDir: false },
  plugins: [exportReleaseMiddleware(), polarisDevMiddleware(), nodeDefsDevMiddleware()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.POLARUI_PORT ?? 5170),
    // 端口固定 5170：被占用时直接报错，不允许静默漂移到 5171+
    strictPort: true,
    proxy: {
      '/api/polaris': {
        target: HUB,
        changeOrigin: true,
        bypass(req) {
          const m = req.url?.match(/^\/api\/polaris\/([^/?]+)$/);
          if (!m) return;
          const project = decodeURIComponent(m[1]);
          const localPath = join(POLARUI_ROOT, project === 'PolarUI' ? 'polaris.json' : `../${project}/polaris.json`);
          if (existsSync(localPath)) return req.url;
        },
      },
      '/api/services': { target: POLAR_PROCESS, changeOrigin: true },
      '/api/watchdog': { target: POLAR_PROCESS, changeOrigin: true },
    },
  },
});
