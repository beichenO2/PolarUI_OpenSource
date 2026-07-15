import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseProductManifest } from '../src/manifest.js';

const valid = {
  contract_version: '1.0',
  product: { id: 'research', name: 'Research', context_label: '项目', route_label: '路线' },
  workflow: { id: 'research-loop', endpoint: 'http://engine/run/research-loop/flow.json' },
  stages: [
    {
      key: 'define',
      label: '定义问题',
      component_key: 'structured_form',
      internal_states: ['start', 'clarify'],
      actions: [{ key: 'confirm_problem', label: '确认问题' }],
    },
  ],
};

describe('parseProductManifest', () => {
  it('accepts a bounded stage manifest', () => {
    expect(parseProductManifest(valid).stages[0].key).toBe('define');
  });

  it('rejects duplicate stage keys', () => {
    expect(() => parseProductManifest({ ...valid, stages: [valid.stages[0], valid.stages[0]] }))
      .toThrow(/duplicate stage key/);
  });

  it('rejects arbitrary recursive layout data', () => {
    expect(() => parseProductManifest({ ...valid, layout: { children: [] } }))
      .toThrow();
  });

  it('rejects unknown built-in components', () => {
    const stages = [{ ...valid.stages[0], component_key: 'recursive_page_builder' }];
    expect(() => parseProductManifest({ ...valid, stages })).toThrow(/component_key/);
  });

  it('rejects duplicate action keys inside a stage', () => {
    const action = { key: 'confirm_problem', label: '确认问题' };
    const stages = [{ ...valid.stages[0], actions: [action, action] }];
    expect(() => parseProductManifest({ ...valid, stages })).toThrow(/duplicate action key/);
  });

  it.each([
    ['native Web template', new URL('../../../product.manifest.json', import.meta.url)],
    ['Claude Code workflow', new URL('../../../../../workflows/claude-code/product.manifest.json', import.meta.url)],
  ])('declares controlled release actions for the %s', (_name, manifestUrl) => {
    const manifest = parseProductManifest(JSON.parse(readFileSync(manifestUrl, 'utf8')));

    manifest.stages.forEach((stage, index) => {
      const actionKeys = stage.actions.map((action) => action.key);
      expect(new Set(actionKeys).size).toBe(actionKeys.length);
      expect(actionKeys).toEqual(
        index === manifest.stages.length - 1
          ? ['adopt_thread']
          : ['adopt_thread', 'advance'],
      );
    });
  });
});
