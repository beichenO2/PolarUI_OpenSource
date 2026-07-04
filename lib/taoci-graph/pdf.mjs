import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKFLOW_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../workflows/taoci-outreach');
const OUT_DIR = join(WORKFLOW_ROOT, '.output');

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

  return join(workDir, `${basename}.pdf`);
}
