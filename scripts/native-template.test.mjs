import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveTemplateSource } from './native-template.mjs';

const polaruiRoot = join(import.meta.dirname, '..');

test('native flavor resolves to tracked PolarUI template', () => {
  assert.equal(
    resolveTemplateSource({ flavor: 'native', polaruiRoot, webRoot: '/tmp/web-root' }),
    join(polaruiRoot, 'templates/native-web'),
  );
});

test('legacy flavor resolves to Web_related compatibility template', () => {
  assert.equal(
    resolveTemplateSource({ flavor: 'legacy', polaruiRoot, webRoot: '/tmp/web-root' }),
    '/tmp/web-root/_template',
  );
});

test('unknown flavor is rejected', () => {
  assert.throws(
    () => resolveTemplateSource({ flavor: 'recursive-ui', polaruiRoot, webRoot: '/tmp/web-root' }),
    /unsupported template flavor/,
  );
});
