import { describe, expect, it } from 'vitest';
import { normalizeCheckpointSnapshot } from '../src/domain/types.js';

const sourceCommandId = '80000000-0000-4000-8000-000000000001';

function canonical(overrides: Record<string, unknown> = {}) {
  return {
    workflowState: { cursor: 'workflow-owned' },
    memoryReferences: [],
    artifacts: [],
    ...overrides,
  };
}

describe('checkpoint canonical provenance', () => {
  it('preserves validated top-level Workflow revision and source Command metadata', () => {
    expect(normalizeCheckpointSnapshot(canonical({
      workflowRevision: 'workflow-v17',
      sourceCommandId,
    }))).toEqual(canonical({
      workflowRevision: 'workflow-v17',
      sourceCommandId,
    }));
  });

  it.each([
    ['empty Workflow revision', { workflowRevision: '' }],
    ['oversized Workflow revision', { workflowRevision: 'r'.repeat(201) }],
    ['malformed source Command ID', { sourceCommandId: 'not-a-command-id' }],
    ['empty source Command ID', { sourceCommandId: '' }],
  ])('rejects %s instead of passing unchecked metadata through', (_label, overrides) => {
    expect(() => normalizeCheckpointSnapshot(canonical(overrides))).toThrow(/checkpoint snapshot/i);
  });

  it('preserves a validated legacy compatibility Command for the Web provenance fallback', () => {
    const normalized = normalizeCheckpointSnapshot({
      stages: [{ stage_key: 'work', status: 'active', internal_state: 'running' }],
      command: { id: sourceCommandId, kind: 'message', action_key: null },
    });

    expect(normalized).not.toHaveProperty('sourceCommandId');
    expect(normalized.workflowState.legacyCompatibility?.command?.id).toBe(sourceCommandId);
  });
});
