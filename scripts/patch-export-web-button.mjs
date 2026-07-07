#!/usr/bin/env node
/**
 * Inject「导出网站」floating button — calls POST /api/export-release (same script as CLI).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = join(ROOT, 'dist/index.html');
const assetsDir = join(ROOT, 'dist/assets');
const MARKER = 'export-web-button.mjs';

const script = `/**
 * PolarUI export website button — AUTO-GENERATED
 */
(function () {
  const btn = document.createElement('button');
  btn.id = 'polar-export-web-btn';
  btn.textContent = '导出网站';
  btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;padding:10px 16px;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.2)';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '导出中…';
    try {
      const wf = prompt('workflow_id', 'taoci-outreach') || 'taoci-outreach';
      const res = await fetch('/api/export-release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_id: wf, skip_preflight: true, compile_only: true }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.errors?.join('; ') || data.error || res.status);
      alert('导出成功\\n' + data.release_path);
    } catch (e) {
      alert('导出失败: ' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = '导出网站';
    }
  };
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(btn));
})();
`;

writeFileSync(join(assetsDir, MARKER), script, 'utf8');

let html = readFileSync(indexHtml, 'utf8');
const tag = `<script src="/assets/${MARKER}"></script>`;
if (!html.includes(MARKER)) {
  html = html.replace('</body>', `  ${tag}\n</body>`);
  writeFileSync(indexHtml, html, 'utf8');
}
console.log(`patched export web button: ${MARKER}`);
