import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  checkpointStages,
  normalizeCheckpointSnapshot,
} from '../src/domain/types.js';
import type {
  CheckpointArtifact,
  CheckpointSnapshot,
  LegacyCheckpointStage,
  RouteOrigin,
  WorkflowCheckpoint,
} from '../src/domain/types.js';

type LegacyCompatibilityNamespace = {
  stages: LegacyCheckpointStage[];
  command?: {
    id: string;
    kind: 'message' | 'named_action' | 'resume_interrupt';
    action_key: string | null;
  };
  memoryProposals?: unknown[];
  adoptedThreadId?: string | null;
  resultMessageIds?: string[];
};

const normalizeUnknown = normalizeCheckpointSnapshot as unknown as
  (snapshot: unknown) => CheckpointSnapshot;
const stagesFromUnknown = checkpointStages as unknown as
  (snapshot: unknown) => LegacyCheckpointStage[];

describe('checkpoint snapshot normalization', () => {
  function duplicatedCompatibilitySnapshot() {
    const stages = [{
      stage_key: 'work',
      status: 'active' as const,
      internal_state: 'running',
    }];
    const command = {
      id: '80000000-0000-4000-8000-000000000001',
      kind: 'named_action' as const,
      action_key: 'advance',
    };
    const memoryProposals = [{
      scope: 'context',
      value: 'Remember this',
    }];
    const adoptedThreadId = '50000000-0000-4000-8000-000000000001';
    const resultMessageIds = [
      '90000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000002',
    ];
    return {
      workflowState: {
        legacyCompatibility: {
          stages,
          command,
          memoryProposals,
          adoptedThreadId,
          resultMessageIds,
        },
      },
      memoryReferences: [],
      artifacts: [],
      stages,
      command,
      memory_proposals: memoryProposals,
      adopted_thread_id: adoptedThreadId,
      result_message_ids: resultMessageIds,
    };
  }

  it('accepts a canonical-only snapshot and preserves arbitrary Workflow projection statuses', () => {
    const snapshot = {
      workflowState: {
        revision: 'workflow-v7',
        cursor: { step: 4 },
      },
      stageProjection: {
        revision: 'workflow-v7',
        items: [
          {
            key: 'legal_review',
            label: 'Legal review',
            status: 'awaiting_external_counsel',
            checkpointId: '40000000-0000-4000-8000-000000000001',
            summary: 'Waiting for counsel',
          },
        ],
      },
      memoryReferences: [
        {
          memoryId: '60000000-0000-4000-8000-000000000001',
          version: 3,
        },
      ],
      artifacts: [{
        id: '70000000-0000-4000-8000-000000000001',
        stage_key: null,
        filename: 'result.txt',
        media_type: 'text/plain',
        byte_size: 6,
        sha256: 'a'.repeat(64),
        created_at: '2026-07-17T12:00:00.000Z',
      }],
    };

    const normalized = normalizeUnknown(snapshot);

    expect(normalized).toEqual(snapshot);
    expect(normalized).not.toHaveProperty('stages');
    expect(normalized.stageProjection?.items).toEqual(snapshot.stageProjection.items);
    expect(stagesFromUnknown(normalized)).toEqual([]);
  });

  it('distinguishes absent and zero-item canonical projections from malformed projections', () => {
    const absentProjection = normalizeUnknown({
      workflowState: { revision: 'workflow-without-projection' },
      memoryReferences: [],
      artifacts: [],
    });
    const emptyProjection = normalizeUnknown({
      workflowState: { revision: 'workflow-empty-projection' },
      stageProjection: {
        revision: 'workflow-empty-projection',
        items: [],
      },
      memoryReferences: [],
      artifacts: [],
    });

    expect(absentProjection).not.toHaveProperty('stageProjection');
    expect(emptyProjection.stageProjection).toEqual({
      revision: 'workflow-empty-projection',
      items: [],
    });
    expect(() => normalizeUnknown({
      workflowState: {},
      stageProjection: {
        revision: 'malformed',
        items: 'not-an-array',
      },
      memoryReferences: [],
      artifacts: [],
    })).toThrow(/stage projection/i);
  });

  it('normalizes a complete 0002-0004 snapshot into an explicit compatibility namespace', () => {
    const stages: LegacyCheckpointStage[] = [{
      stage_key: 'work',
      status: 'active',
      internal_state: 'running',
    }];
    const artifact = {
      id: '70000000-0000-4000-8000-000000000002',
      stage_key: 'work',
      filename: 'legacy.txt',
      media_type: 'text/plain',
      byte_size: 6,
      sha256: 'b'.repeat(64),
      created_at: '2026-07-16T12:00:00.000Z',
    };
    const legacy = {
      stages,
      artifacts: [artifact],
      command: {
        id: '80000000-0000-4000-8000-000000000001',
        kind: 'named_action',
        action_key: 'advance',
      },
      memory_proposals: [{
        scope: 'context',
        value: 'Remember this',
      }],
      adopted_thread_id: '50000000-0000-4000-8000-000000000001',
      result_message_ids: [
        '90000000-0000-4000-8000-000000000001',
        '90000000-0000-4000-8000-000000000002',
      ],
    };

    const normalized = normalizeUnknown(legacy);

    expect(normalized).toEqual({
      ...legacy,
      workflowState: {
        legacyCompatibility: {
          stages,
          command: legacy.command,
          memoryProposals: legacy.memory_proposals,
          adoptedThreadId: legacy.adopted_thread_id,
          resultMessageIds: legacy.result_message_ids,
        },
      },
      stageProjection: {
        revision: 'legacy-0002-0004',
        items: [{
          key: 'work',
          label: 'work',
          status: 'active',
          summary: 'running',
        }],
      },
      memoryReferences: [],
      artifacts: [artifact],
    });
    expect(stagesFromUnknown(normalized)).toEqual(stages);
  });

  it('accepts matching top-level and namespaced compatibility metadata without loss', () => {
    const snapshot = duplicatedCompatibilitySnapshot();

    expect(normalizeUnknown(snapshot)).toEqual(snapshot);
    expect(stagesFromUnknown(snapshot)).toEqual(snapshot.stages);
  });

  it.each([
    [
      'command',
      {
        command: {
          id: '80000000-0000-4000-8000-000000000002',
          kind: 'named_action',
          action_key: 'advance',
        },
      },
    ],
    [
      'memory proposals',
      {
        memory_proposals: [{
          scope: 'context',
          value: 'Conflicting value',
        }],
      },
    ],
    [
      'adopted thread',
      {
        adopted_thread_id: '50000000-0000-4000-8000-000000000002',
      },
    ],
    [
      'result message IDs',
      {
        result_message_ids: [
          '90000000-0000-4000-8000-000000000003',
        ],
      },
    ],
  ])('rejects conflicting top-level and namespaced %s metadata', (_case, override) => {
    expect(() => normalizeUnknown({
      ...duplicatedCompatibilitySnapshot(),
      ...override,
    })).toThrow(/legacy compatibility.*ambiguous/i);
  });

  it.each([
    {
      name: 'invalid legacy status',
      snapshot: {
        stages: [{
          stage_key: 'work',
          status: 'paused',
          internal_state: 'waiting',
        }],
      },
    },
    {
      name: 'invalid legacy item shape',
      snapshot: {
        stages: [{
          stage_key: 7,
          status: 'active',
          internal_state: 'running',
        }],
      },
    },
    {
      name: 'non-array legacy stages',
      snapshot: { stages: 'work' },
    },
  ])('rejects $name instead of silently producing an empty projection', ({ snapshot }) => {
    expect(() => stagesFromUnknown(snapshot)).toThrow(/legacy checkpoint stages/i);
    expect(() => normalizeUnknown(snapshot)).toThrow(/legacy checkpoint stages/i);
  });

  it('rejects duplicate or structurally invalid canonical projection items', () => {
    expect(() => normalizeUnknown({
      workflowState: {},
      stageProjection: {
        revision: 'workflow-v7',
        items: [
          { key: 'review', label: 'Review', status: 'active' },
          { key: 'review', label: 'Review again', status: 'waiting' },
        ],
      },
      memoryReferences: [],
      artifacts: [],
    })).toThrow(/duplicate.*projection|projection.*duplicate/i);

    expect(() => normalizeUnknown({
      workflowState: {},
      stageProjection: {
        revision: 'workflow-v7',
        items: [{
          key: 'review',
          status: 'active',
        }],
      },
      memoryReferences: [],
      artifacts: [],
    })).toThrow(/stage projection/i);
  });

  it('rejects objects missing required canonical fields instead of treating them as legacy', () => {
    expect(() => normalizeUnknown({
      workflowState: {},
    })).toThrow(/checkpoint snapshot/i);
    expect(() => normalizeUnknown({
      workflowState: {},
      memoryReferences: [],
      artifacts: 'not-an-array',
    })).toThrow(/checkpoint snapshot|artifacts/i);
  });
});

describe('public checkpoint Stage metadata types', () => {
  it('accepts unknown persistence input and returns the canonical snapshot contract', () => {
    expectTypeOf(normalizeCheckpointSnapshot)
      .toEqualTypeOf<(snapshot: unknown) => CheckpointSnapshot>();
    expectTypeOf(checkpointStages)
      .toEqualTypeOf<(snapshot: unknown) => LegacyCheckpointStage[]>();
  });

  it('types the legacy compatibility namespace explicitly', () => {
    expectTypeOf<CheckpointSnapshot['workflowState']['legacyCompatibility']>()
      .toEqualTypeOf<LegacyCompatibilityNamespace | undefined>();
  });

  it('represents legacy Stage metadata as nullable on public checkpoint records', () => {
    expectTypeOf<WorkflowCheckpoint['stageKey']>()
      .toEqualTypeOf<string | null>();
    expectTypeOf<RouteOrigin['stageKey']>()
      .toEqualTypeOf<string | null>();
    expectTypeOf<CheckpointArtifact['stage_key']>()
      .toEqualTypeOf<string | null>();
  });
});
