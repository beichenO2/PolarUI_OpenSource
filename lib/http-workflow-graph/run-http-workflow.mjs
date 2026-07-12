/**
 * HttpWorkflow node — POST /run contract (ADR-012).
 * SSoT for HttpWorkflow — headless overlay and GUI executor.ts both import this module.
 */

export const DEFAULT_TIMEOUT_MS = 60000;

/** @param {string} url */
export function resolveHttpWorkflowRunUrl(url) {
  const trimmed = String(url ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/run') ? trimmed : `${trimmed}/run`;
}

/**
 * @param {Record<string, unknown>} params
 * @param {Record<string, unknown>} inputs
 * @param {{ runContext?: Record<string, unknown> }} [ctx]
 */
export function buildHttpWorkflowRequestBody(params, inputs, ctx = {}) {
  const body = { message: String(inputs.message ?? '') };

  const userId = inputs.user_id ?? params.user_id ?? ctx.runContext?.user_id;
  if (userId != null && String(userId).trim()) body.userId = String(userId);

  const scenarioId = inputs.scenario_id ?? params.scenario_id ?? ctx.runContext?.scenario_id;
  if (scenarioId !== undefined) {
    body.scenarioId = scenarioId == null ? null : String(scenarioId);
  }

  const sessionId = inputs.session_id
    ?? params.session_id
    ?? ctx.runContext?.session_id
    ?? ctx.runContext?.conversation_id;
  if (sessionId != null && String(sessionId).trim()) body.sessionId = String(sessionId);

  if (inputs.history != null) body.history = inputs.history;
  const memoryPayload = inputs.memory_payload ?? inputs.memoryPayload;
  if (memoryPayload != null) body.memoryPayload = memoryPayload;
  if (inputs.config != null) body.config = inputs.config;

  const workflowId = params.workflow_id ?? params.workflowId;
  if (workflowId != null && String(workflowId).trim()) body.workflowId = String(workflowId);

  return body;
}

/**
 * @param {{
 *   params: Record<string, unknown>,
 *   inputs: Record<string, unknown>,
 *   ctx?: { runContext?: Record<string, unknown> },
 *   fetchImpl?: typeof fetch,
 * }} opts
 */
export async function runHttpWorkflow({ params, inputs, ctx = {}, fetchImpl = fetch }) {
  const url = resolveHttpWorkflowRunUrl(String(params.url ?? inputs.url ?? ''));
  const timeoutMs = Number(params.timeout_ms ?? DEFAULT_TIMEOUT_MS);

  if (!url) {
    return {
      outputs: { ok: false, reply: '', memory_delta: {}, error: 'url 未配置' },
      duration_ms: 0,
    };
  }

  const message = String(inputs.message ?? '');
  if (!message) {
    return {
      outputs: { ok: false, reply: '', memory_delta: {}, error: 'message 必填' },
      duration_ms: 0,
    };
  }

  const body = buildHttpWorkflowRequestBody(params, inputs, ctx);
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  const authToken = String(params.auth_token ?? '').trim();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        outputs: { ok: false, reply: '', memory_delta: {}, error: `HTTP ${res.status}` },
        duration_ms: Date.now() - start,
      };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return {
        outputs: { ok: false, reply: '', memory_delta: {}, error: '响应非 JSON' },
        duration_ms: Date.now() - start,
      };
    }

    if (!data || typeof data !== 'object') {
      return {
        outputs: { ok: false, reply: '', memory_delta: {}, error: '响应格式无效' },
        duration_ms: Date.now() - start,
      };
    }

    const ok = Boolean(data.ok);
    const reply = typeof data.reply === 'string' ? data.reply : '';
    const memory_delta = data.memory_delta && typeof data.memory_delta === 'object'
      ? data.memory_delta
      : {};
    const error = ok
      ? ''
      : String(data.error ?? (reply || '业务失败'));

    return {
      outputs: { ok, reply, memory_delta, error },
      duration_ms: Date.now() - start,
    };
  } catch (e) {
    const errMsg = e?.name === 'AbortError'
      ? '请求超时'
      : (e instanceof Error ? e.message : String(e));
    return {
      outputs: { ok: false, reply: '', memory_delta: {}, error: errMsg },
      duration_ms: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

export default runHttpWorkflow;
