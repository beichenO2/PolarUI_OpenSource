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
            res.statusCode = result.ok ? 200 : 412;
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

export default defineConfig({
  root: join(POLARUI_ROOT, 'dist'),
  plugins: [exportReleaseMiddleware(), polarisDevMiddleware()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.POLARUI_PORT ?? 5170),
    strictPort: false,
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
