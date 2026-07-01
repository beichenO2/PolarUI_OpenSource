import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, '.output');

export async function compileLatex(texContent, basename) {
  if (process.env.TAOCI_MOCK_PDF === '1') {
    await mkdir(OUT_DIR, { recursive: true });
    const pdfPath = join(OUT_DIR, `${basename}.mock.pdf`);
    await writeFile(pdfPath, `% mock pdf for ${basename}`, 'utf8');
    return pdfPath;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const workDir = join(OUT_DIR, basename);
  await mkdir(workDir, { recursive: true });
  const texPath = join(workDir, `${basename}.tex`);
  await writeFile(texPath, texContent, 'utf8');

  for (let i = 0; i < 2; i++) {
    const r = spawnSync('xelatex', ['-interaction=nonstopmode', `${basename}.tex`], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.status !== 0 && i === 1) {
      throw new Error(`xelatex failed: ${(r.stderr || r.stdout || '').slice(-500)}`);
    }
  }

  const pdfPath = join(workDir, `${basename}.tex`.replace(/\.tex$/, '.pdf'));
  return pdfPath;
}

export async function loadTemplate(name) {
  const p = join(ROOT, 'templates', name);
  return readFile(p, 'utf8');
}

export function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v ?? ''));
  }
  return out;
}
