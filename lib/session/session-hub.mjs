/**
 * Browser-safe session store — Hub file API with in-memory fallback.
 * Paths relative to Polarisor root (Hub resolveWithinRoot).
 */

export const DEFAULT_SESSION = {
  step: 'S0_Clarify',
  teacher: { name: '', institution: '', url: '' },
  student: { profile: '', files: [] },
  research: null,
  selected_direction: null,
  outreach_draft: null,
  artifacts: { overview_pdf: null, prep_pdf: null },
  history: [],
};

const SESSION_DIR = 'PolarUI/.data/taoci-sessions/.sessions';
const memory = new Map();

function hubBase() {
  if (typeof window !== 'undefined') return '';
  return process.env.POLAR_HUB_URL ?? 'http://127.0.0.1:8040';
}

function sessionPath(conversationId) {
  return `${SESSION_DIR}/${conversationId}.json`;
}

async function hubRead(path) {
  const res = await fetch(`${hubBase()}/api/ui/tools/file-read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`session read ${res.status}`);
  const data = await res.json();
  return data.content ?? null;
}

async function hubWrite(path, content) {
  const res = await fetch(`${hubBase()}/api/ui/tools/file-write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, create_dirs: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`session write ${res.status}`);
}

export async function loadSession(conversationId) {
  const key = sessionPath(conversationId);
  try {
    const raw = await hubRead(key);
    if (raw) {
      const session = { ...structuredClone(DEFAULT_SESSION), ...JSON.parse(raw) };
      memory.set(conversationId, session);
      return session;
    }
  } catch {
    /* fall through to memory */
  }
  if (memory.has(conversationId)) {
    return structuredClone(memory.get(conversationId));
  }
  return structuredClone(DEFAULT_SESSION);
}

export async function saveSession(conversationId, session) {
  session.updated_at = new Date().toISOString();
  memory.set(conversationId, structuredClone(session));
  const key = sessionPath(conversationId);
  try {
    await hubWrite(key, JSON.stringify(session, null, 2));
  } catch {
    /* in-memory only — GUI run still works */
  }
  return session;
}

export function appendHistory(session, role, content) {
  session.history.push({ role, content, at: new Date().toISOString() });
  if (session.history.length > 40) session.history = session.history.slice(-40);
}

export function sessionSummary(session) {
  return JSON.stringify(
    {
      step: session.step,
      teacher: session.teacher,
      student: { profile: session.student.profile, file_count: session.student.files?.length ?? 0 },
      selected_direction: session.selected_direction,
      has_research: !!session.research,
    },
    null,
    2,
  );
}
