/**
 * Serve PolarUI node-defs/ (SSoT) via fetch for headless bundle boot.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const NODE_DEFS_ROOT = join(__dirname, '../node-defs');

const nativeFetch = globalThis.fetch;

export function installNodeDefsFetch() {
  if (globalThis.__polaruiNodeDefsFetchInstalled) return;
  globalThis.__polaruiNodeDefsFetchInstalled = true;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (url.includes('/node-defs/')) {
      const pathOnly = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      const rel = pathOnly.replace(/^\/node-defs\//, '');
      const filePath = join(NODE_DEFS_ROOT, rel);
      if (existsSync(filePath)) {
        const body = readFileSync(filePath, 'utf8');
        const type = rel.endsWith('.json') ? 'application/json' : 'text/plain';
        return new Response(body, { status: 200, headers: { 'Content-Type': type } });
      }
    }
    if (typeof nativeFetch === 'function') {
      return nativeFetch(input, init);
    }
    throw new Error(`fetch not available for ${url}`);
  };
}
