import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

let parserPromise;
async function loadParser() {
  const templateRoot = join(import.meta.dirname, '../templates/native-web');
  const sdkEntry = join(templateRoot, 'packages/product-sdk/dist/index.js');
  if (!existsSync(sdkEntry)) {
    const install = spawnSync('npm', ['install'], { cwd: templateRoot, stdio: 'inherit' });
    if (install.status !== 0) throw new Error('native template npm install failed');
    const build = spawnSync(
      'npm',
      ['run', 'build', '-w', '@polar/native-web-product-sdk'],
      { cwd: templateRoot, stdio: 'inherit' },
    );
    if (build.status !== 0) throw new Error('native product SDK build failed');
  }
  parserPromise ??= import(pathToFileURL(sdkEntry).href);
  return parserPromise;
}

export async function compileProductManifest({ workflowDir, workflowId, releaseId }) {
  const raw = JSON.parse(readFileSync(join(workflowDir, 'product.manifest.json'), 'utf8'));
  const normalized = {
    ...raw,
    product: { ...raw.product, id: releaseId.replace(/_/g, '-') },
    workflow: {
      ...raw.workflow,
      id: workflowId,
    },
  };
  const { parseProductManifest } = await loadParser();
  return parseProductManifest(normalized);
}
