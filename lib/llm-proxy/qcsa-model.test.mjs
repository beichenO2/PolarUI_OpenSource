import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModelCode,
  fallbackModelChain,
  bundleFragments,
} from './qcsa-model.mjs';

describe('resolveModelCode (4-bit QCSA)', () => {
  it('maps GLM-5.1 alias → 0000', () => {
    assert.equal(resolveModelCode('GLM-5.1'), '0000');
  });

  it('passes through 4-bit codes', () => {
    assert.equal(resolveModelCode('0001'), '0001');
    assert.equal(resolveModelCode('V0000'), 'V0000');
  });

  it('upgrades legacy 3-bit 100 → 0000', () => {
    assert.equal(resolveModelCode('100'), '0000');
  });

  it('local tier prefixes L', () => {
    assert.equal(resolveModelCode('0000', 'local'), 'L0000');
  });

  it('rejects unknown codes', () => {
    assert.throws(() => resolveModelCode('bogus'), /Unknown model code/);
  });
});

describe('fallbackModelChain', () => {
  it('adds fallbacks for flagship codes', () => {
    assert.deepEqual(fallbackModelChain('1000'), ['1000', '0000', '0010']);
  });
});

describe('bundleFragments', () => {
  it('includes 4-bit tcn mapping', () => {
    const { tcn, v5t, icn } = bundleFragments();
    assert.match(tcn, /"GLM-5\.1":"0000"/);
    assert.match(v5t, /\[01\]\{4\}/);
    assert.match(icn, /0010/);
  });
});
