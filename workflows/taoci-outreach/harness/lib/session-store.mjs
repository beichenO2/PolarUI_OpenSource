import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SESSION_DIR = process.env.TAOCI_SESSION_DIR
  ?? join(ROOT, '.sessions');

const DEFAULT_SESSION = {
  step: 'S0_Clarify',
  teacher: { name: '', institution: '', url: '' },
  student: { profile: '', files: [] },
  research: null,
  selected_direction: null,
  outreach_draft: null,
  artifacts: { overview_pdf: null, prep_pdf: null },
  history: [],
};

export async function loadSession(conversationId) {
  await mkdir(SESSION_DIR, { recursive: true });
  const path = join(SESSION_DIR, `${conversationId}.json`);
  try {
    const raw = await readFile(path, 'utf8');
    return { ...structuredClone(DEFAULT_SESSION), ...JSON.parse(raw) };
  } catch {
    return structuredClone(DEFAULT_SESSION);
  }
}

export async function saveSession(conversationId, session) {
  await mkdir(SESSION_DIR, { recursive: true });
  const path = join(SESSION_DIR, `${conversationId}.json`);
  session.updated_at = new Date().toISOString();
  await writeFile(path, JSON.stringify(session, null, 2), 'utf8');
  return session;
}

export function appendHistory(session, role, content) {
  session.history.push({ role, content, at: new Date().toISOString() });
  if (session.history.length > 40) session.history = session.history.slice(-40);
}
