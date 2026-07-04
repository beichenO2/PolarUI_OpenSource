import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_ROOT = join(__dirname, '../../workflows/taoci-outreach');

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

export function sessionDir() {
  return process.env.TAOCI_SESSION_DIR ?? join(WORKFLOW_ROOT, '.sessions');
}

export async function loadSession(conversationId) {
  await mkdir(sessionDir(), { recursive: true });
  const path = join(sessionDir(), `${conversationId}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    return { ...structuredClone(DEFAULT_SESSION), ...JSON.parse(raw) };
  } catch {
    return structuredClone(DEFAULT_SESSION);
  }
}

export async function saveSession(conversationId, session) {
  await mkdir(sessionDir(), { recursive: true });
  const path = join(sessionDir(), `${conversationId}.json`);
  session.updated_at = new Date().toISOString();
  await writeFile(path, JSON.stringify(session, null, 2), 'utf8');
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
