#!/usr/bin/env node
/**
 * Long-lived HTTP server exposing Workflow POST /run contract for PolarUI graph workflows.
 * Register via site.config.json http_workflows[] instead of per-request graph-cli spawns.
 */
import http from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTaociOutput } from './run-graph-output.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLARUI_ROOT = join(__dirname, '..');

const DEFAULT_WORKFLOW = process.env.POLARUI_RUN_DEFAULT_WORKFLOW || 'claude-code';
const SERVICE_NAME = 'polarui-run-graph';

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** @returns {string[]} */
function defaultListWorkflowIds() {
  const registryPath = join(POLARUI_ROOT, 'dist/workflows/registry.json');
  if (existsSync(registryPath)) {
    try {
      const entries = JSON.parse(readFileSync(registryPath, 'utf8'));
      if (Array.isArray(entries)) {
        return entries.map((e) => e?.id).filter(Boolean);
      }
    } catch {
      /* fall through */
    }
  }
  const workflowsDir = join(POLARUI_ROOT, 'workflows');
  if (!existsSync(workflowsDir)) return [];
  return readdirSync(workflowsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => existsSync(join(workflowsDir, id, `${id}.json`)));
}

/**
 * @param {{ runWorkflow?: (opts: { workflowId: string; inputs: object }) => Promise<object>; listWorkflowIds?: () => string[] }} [deps]
 * @returns {import('node:http').Server}
 */
export function createRunGraphServer({ runWorkflow, listWorkflowIds } = {}) {
  /** @type {(opts: { workflowId: string; inputs: object }) => Promise<object>} */
  let runWorkflowFn = runWorkflow;
  /** @type {() => string[]} */
  let listIdsFn = listWorkflowIds ?? defaultListWorkflowIds;

  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url?.split('?')[0] ?? '';

      if (req.method === 'GET' && url === '/health') {
        const health = { ok: true, service: SERVICE_NAME };
        const workflows = listIdsFn();
        if (Array.isArray(workflows) && workflows.length) {
          health.workflows = workflows;
        }
        return sendJson(res, 200, health);
      }

      if (req.method === 'POST' && url === '/run') {
        let body;
        try {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return sendJson(res, 200, { ok: false, reply: '请求体非 JSON' });
        }

        const message = body.message;
        if (typeof message !== 'string' || !message.trim()) {
          return sendJson(res, 200, { ok: false, reply: '缺少 message' });
        }

        if (!runWorkflowFn) {
          const { runWorkflowGraph } = await import('./run-graph.mjs');
          runWorkflowFn = runWorkflowGraph;
        }

        const workflowId = body.workflowId || DEFAULT_WORKFLOW;
        const sessionId = body.sessionId;
        const conversationId = sessionId ?? `run-${Date.now()}`;

        const inputs = {
          conversationId,
          message,
          userId: body.userId ?? '',
          files: [],
          memory: body.memoryPayload ?? {},
        };

        try {
          const result = await runWorkflowFn({ workflowId, inputs });
          const payload = normalizeTaociOutput(result);
          return sendJson(res, 200, payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return sendJson(res, 200, { ok: false, reply: `工作流服务暂时不可用（${msg}）` });
        }
      }

      return sendJson(res, 404, { ok: false, reply: 'not found' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 200, { ok: false, reply: `工作流服务暂时不可用（${msg}）` });
    }
  });

  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.POLARUI_RUN_PORT) || 3946;
  const server = createRunGraphServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`polarui-run-graph listening on http://127.0.0.1:${port}`);
  });
}
