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

  it('accepts a Stage-independent manifest with optional named intents', () => {
    const { stages: _legacyStages, ...stageIndependent } = valid;
    const intents = [
      { key: 'summarize', label: '总结当前结论' },
      { key: 'request_evidence', label: '请求补充证据' },
    ];

    expect(parseProductManifest({ ...stageIndependent, intents })).toMatchObject({
      intents,
      stages: [],
    });
  });

  it('defaults both legacy Stages and optional intents to empty lists', () => {
    const { stages: _legacyStages, ...stageIndependent } = valid;

    expect(parseProductManifest(stageIndependent)).toMatchObject({
      intents: [],
      stages: [],
    });
  });

  it('rejects duplicate top-level intent keys', () => {
    const { stages: _legacyStages, ...stageIndependent } = valid;
    const intent = { key: 'summarize', label: '总结当前结论' };

    expect(() => parseProductManifest({ ...stageIndependent, intents: [intent, intent] }))
      .toThrow(/duplicate intent key/);
  });

  it('accepts an optional public demo login contract', () => {
    const demoLogin = {
      email: 'demo@native-web.test',
      username: 'demo',
      password: 'Demo-Workflow-2026!',
    };

    expect(parseProductManifest({ ...valid, demo_login: demoLogin }).demo_login)
      .toEqual(demoLogin);
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

  it('ships the native Web template without hard-coded Stages', () => {
    const manifest = parseProductManifest(JSON.parse(readFileSync(
      new URL('../../../product.manifest.json', import.meta.url),
      'utf8',
    )));

    expect(manifest.stages).toEqual([]);
    expect(manifest.intents.map((intent) => intent.key)).toEqual([
      'summarize',
      'request_evidence',
    ]);
  });

  it('continues parsing controlled actions from a legacy Workflow manifest', () => {
    const manifest = parseProductManifest(JSON.parse(readFileSync(
      new URL('../../../../../workflows/claude-code/product.manifest.json', import.meta.url),
      'utf8',
    )));

    manifest.stages.forEach((stage, index) => {
      const actionKeys = stage.actions.map((action) => action.key);
      expect(new Set(actionKeys).size).toBe(actionKeys.length);
      expect(actionKeys).toEqual(
        index === manifest.stages.length - 1
          ? ['adopt_thread']
          : ['adopt_thread', 'advance'],
      );
    });
    expect(manifest.stages.length).toBeGreaterThan(0);
  });
});
