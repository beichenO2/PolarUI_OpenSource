/**
 * Claude Code 智能 core — 优先 claude CLI，fallback PolarPrivate OpenAI-compatible API
 */

const POLARPRIVATE_URL = process.env.POLARPRIVATE_URL ?? 'http://127.0.0.1:12790';
const MODEL = process.env.TAOCI_MODEL ?? 'GLM-5.1';

let completeOverride = null;

export function setCompleteOverride(fn) {
  completeOverride = fn;
}

export function clearCompleteOverride() {
  completeOverride = null;
}

/** 由 harness 注入，供 mock LLM 读取 session 状态 */
let activeSession = null;

export function setActiveSession(session) {
  activeSession = session;
}

async function mockFromEnv(session) {
  if (process.env.TAOCI_MOCK_LLM !== '1') return null;
  const { mockForSession } = await import('../../tests/mocks/llm-responses.mjs');
  return mockForSession(session ?? { step: 'S0_Clarify', history: [] });
}

export async function complete({ system, user, json = false }) {
  if (completeOverride) {
    return completeOverride({ system, user, json });
  }
  const mocked = await mockFromEnv(activeSession);
  if (mocked !== null) {
    return json ? mocked : JSON.stringify(mocked);
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  // Try claude CLI if available
  if (process.env.TAOCI_USE_CLAUDE_CLI !== '0') {
    try {
      const { spawnSync } = await import('node:child_process');
      const prompt = [system, user].filter(Boolean).join('\n\n---\n\n');
      const r = spawnSync('claude', ['-p', prompt, '--output-format', 'text'], {
        encoding: 'utf8',
        timeout: 300_000,
        env: { ...process.env },
      });
      if (r.status === 0 && r.stdout?.trim()) {
        return parseMaybeJson(r.stdout.trim(), json);
      }
    } catch {
      /* fallback */
    }
  }

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
  const text = data.choices?.[0]?.message?.content ?? '';
  return parseMaybeJson(text.trim(), json);
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
