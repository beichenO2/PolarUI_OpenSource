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
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARACTERS = 20_000;
const MAX_WORKFLOW_ID_CHARACTERS = 200;
const MAX_ATTACHMENTS = 100;
const MAX_HISTORY_ENTRIES = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

class RequestBodyTooLargeError extends Error {}

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
function readBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      reject(new RequestBodyTooLargeError());
      return;
    }
    req.on('data', (chunk) => {
      if (tooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedNonEmptyString(value, maxCharacters) {
  const normalized = nonEmptyString(value);
  return normalized !== undefined && normalized.length <= maxCharacters ? normalized : undefined;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function validV2Input(input) {
  if (!isRecord(input)) return false;
  if (input.type === 'message') {
    return hasOnlyKeys(input, ['type', 'content']) &&
      boundedNonEmptyString(input.content, MAX_CONTENT_CHARACTERS) !== undefined;
  }
  if (input.type === 'named_intent') {
    const key = boundedNonEmptyString(input.key, 200);
    return hasOnlyKeys(input, ['type', 'key', 'content']) &&
      key !== undefined && /^[a-z][a-z0-9_]*$/u.test(key) &&
      (input.content === undefined ||
        (typeof input.content === 'string' && input.content.trim().length <= MAX_CONTENT_CHARACTERS));
  }
  if (input.type === 'resume_interrupt') {
    return hasOnlyKeys(input, ['type', 'interruptId', 'content']) &&
      isUuid(input.interruptId) &&
      boundedNonEmptyString(input.content, MAX_CONTENT_CHARACTERS) !== undefined;
  }
  return false;
}

function v2Message(input) {
  if (!isRecord(input)) return undefined;
  if (input.type === 'message' || input.type === 'resume_interrupt') {
    return nonEmptyString(input.content);
  }
  if (input.type !== 'named_intent') return undefined;
  return nonEmptyString(input.content) ?? nonEmptyString(input.key);
}

function validHistory(value) {
  return Array.isArray(value) && value.length <= MAX_HISTORY_ENTRIES &&
    value.every((entry) => isRecord(entry) &&
      (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.content === 'string' && entry.content.length <= MAX_CONTENT_CHARACTERS);
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
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            return sendJson(res, 200, { ok: false, reply: '请求体过大' });
          }
          return sendJson(res, 200, { ok: false, reply: '请求体非 JSON' });
        }

        const v2 = body.contract_version === '2.0';
        const command = v2 && isRecord(body.command) ? body.command : undefined;
        const message = v2 ? v2Message(command?.input) : body.message;
        if (typeof message !== 'string' || !message.trim()) {
          return sendJson(res, 200, { ok: false, reply: '缺少 message' });
        }

        if (v2 && (!command || !isUuid(command.id) ||
            !isUuid(command.context_id) || !isUuid(command.route_id) ||
            !isUuid(command.conversation_id) || !isUuid(command.base_checkpoint_id) ||
            !Number.isInteger(command.expected_checkpoint_version) ||
            command.expected_checkpoint_version < 0 ||
            !validV2Input(command.input) ||
            !Array.isArray(command.attachments) || command.attachments.length > MAX_ATTACHMENTS ||
            !command.attachments.every(isUuid) ||
            new Set(command.attachments).size !== command.attachments.length ||
            !validHistory(body.history) || !isRecord(body.memory) ||
            !isRecord(body.checkpoint_snapshot) ||
            (body.workflow_id !== undefined &&
              boundedNonEmptyString(body.workflow_id, MAX_WORKFLOW_ID_CHARACTERS) === undefined) ||
            (body.user_id !== undefined && !isUuid(body.user_id)))) {
          return sendJson(res, 200, { ok: false, reply: '请求体无效' });
        }

        if (!runWorkflowFn) {
          const { runWorkflowGraph } = await import('./run-graph.mjs');
          runWorkflowFn = runWorkflowGraph;
        }

        const workflowId = (v2 ? nonEmptyString(body.workflow_id) : nonEmptyString(body.workflowId)) ||
          DEFAULT_WORKFLOW;
        const sessionId = v2
          ? nonEmptyString(command.conversation_id) ?? nonEmptyString(command.route_id)
          : body.sessionId;
        const conversationId = sessionId ?? `run-${Date.now()}`;

        const inputs = v2 ? {
          conversationId,
          message,
          userId: typeof body.user_id === 'string' ? body.user_id : '',
          files: [],
          memory: body.memory,
          history: body.history,
          command,
          checkpointSnapshot: body.checkpoint_snapshot,
        } : {
          conversationId,
          message,
          userId: body.userId ?? '',
          files: [],
          memory: body.memoryPayload ?? {},
          history: Array.isArray(body.history) ? body.history : [],
          command: body.input && typeof body.input === 'object' ? body.input : {},
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
