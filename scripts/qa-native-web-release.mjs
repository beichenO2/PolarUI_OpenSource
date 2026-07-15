import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { exportRelease } from './export-release.mjs';

const root = mkdtempSync(join(tmpdir(), 'polar-native-qa-'));
const image = `polar-native-qa:${Date.now()}`;
const container = `polar-native-qa-${process.pid}`;
const port = 3990;

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`health timeout: ${url}`);
}

try {
  const result = await exportRelease({
    workflow: 'claude-code',
    webRoot: root,
    templateFlavor: 'native',
    skipPreflight: true,
    compileOnly: true,
    silent: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));

  const build = spawnSync('docker', ['build', '-t', image, '.'], {
    cwd: result.release_path,
    stdio: 'inherit',
  });
  if (build.status !== 0) throw new Error('docker build failed');

  const run = spawnSync('docker', [
    'run', '--rm', '-d', '--name', container, '-p', `${port}:3920`, image,
  ], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error('docker run failed');

  await waitForHealth(`http://127.0.0.1:${port}/healthz`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.getByTestId('product-bar').waitFor();
  await page.getByRole('button', { name: '项目工作' }).click();
  if (await page.getByText(/LibreChat/i).count()) throw new Error('LibreChat text visible');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('workspace-slot').waitFor();
  await browser.close();
  console.log('[QA PASS] native export production container');
} finally {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  spawnSync('docker', ['rmi', '-f', image], { stdio: 'ignore' });
  rmSync(root, { recursive: true, force: true });
}
