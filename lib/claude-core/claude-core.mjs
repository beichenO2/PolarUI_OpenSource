/**
 * Claude Code 智能 core — CLI 子进程（--print headless）→ anthropic-proxy-shim → PolarPrivate
 * 测试时设 TAOCI_MOCK_LLM=1 或 TAOCI_USE_CLAUDE_CLI=0 走 mock / PolarPrivate 直连。
 */

const POLARPRIVATE_URL = process.env.POLARPRIVATE_URL ?? 'http://127.0.0.1:12790';
const MODEL = process.env.TAOCI_MODEL ?? 'GLM-5.1';
const SHIM_URL = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:12791';
const CLAUDE_CODE_PKG = process.env.TAOCI_CLAUDE_CODE_PKG ?? '@anthropic-ai/claude-code@2.1.160';
const WORKSPACE = process.env.TAOCI_WORKSPACE ?? process.env.HOME
  ? `${process.env.HOME}/Polarisor`
  : '~/Polarisor';

let completeOverride = null;

export function setCompleteOverride(fn) {
  completeOverride = fn;
}

export function clearCompleteOverride() {
  completeOverride = null;
}

let activeSession = null;

export function setActiveSession(session) {
  activeSession = session;
}

async function mockFromEnv(session) {
  if (process.env.TAOCI_MOCK_LLM !== '1') return null;
  const { mockForSession } = await import('./mocks/llm-responses.mjs');
  return mockForSession(session ?? { step: 'S0_Clarify', history: [] });
}

/** 解析 Claude Code CLI --output-format json 的 stdout */
export function parseClaudeCodeCliOutput(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (!trimmed) return { ok: false, text: '', error: 'empty stdout' };

  try {
    const payload = JSON.parse(trimmed);
    if (payload.type === 'result') {
      if (payload.subtype === 'success') {
        return { ok: true, text: String(payload.result ?? ''), turns: payload.num_turns };
      }
      return { ok: false, text: '', error: payload.subtype ?? 'cli error' };
    }
    if (typeof payload.result === 'string') {
      return { ok: true, text: payload.result };
    }
  } catch {
    /* fall through — plain text */
  }
  return { ok: true, text: trimmed };
}

async function completeViaClaudeCodeCli({ system, user }) {
  const { spawnSync } = await import('node:child_process');
  const prompt = [system, user].filter(Boolean).join('\n\n---\n\n');
  const args = [
    CLAUDE_CODE_PKG,
    '--print',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    prompt,
  ];

  const r = spawnSync('npx', args, {
    cwd: WORKSPACE,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: SHIM_URL,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'local',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  });

  if (r.status !== 0) {
    const err = (r.stderr ?? r.stdout ?? '').trim().slice(0, 500);
    throw new Error(`Claude Code CLI exit ${r.status}: ${err || 'unknown'}`);
  }

  const parsed = parseClaudeCodeCliOutput(r.stdout);
  if (!parsed.ok) {
    throw new Error(`Claude Code CLI: ${parsed.error ?? 'no result'}`);
  }
  return parsed.text;
}

async function completeViaPolarPrivate({ system, user }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const res = await fetch(`${POLARPRIVATE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'taoci-outreach' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LLM ${res.status}: ${t.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

export async function complete({ system, user, json = false }) {
  if (completeOverride) {
    return completeOverride({ system, user, json });
  }
  const mocked = await mockFromEnv(activeSession);
  if (mocked !== null) {
    return json ? mocked : JSON.stringify(mocked);
  }

  let text;
  if (process.env.TAOCI_USE_CLAUDE_CLI !== '0') {
    try {
      text = await completeViaClaudeCodeCli({ system, user });
    } catch (err) {
      if (process.env.TAOCI_CLI_FALLBACK !== '0') {
        text = await completeViaPolarPrivate({ system, user });
      } else {
        throw err;
      }
    }
  } else {
    text = await completeViaPolarPrivate({ system, user });
  }

  return parseMaybeJson(String(text).trim(), json);
}

function parseMaybeJson(text, json) {
  if (!json) return text;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      return { raw: text, parse_error: true };
    }
  }
  return { raw: text, parse_error: true };
}
