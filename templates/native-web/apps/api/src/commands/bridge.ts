import type { ProductManifest } from '@polar/native-web-product-sdk';
import { z } from 'zod';
import type { RouteStageStatus, StageProjection } from '../domain/types.js';

export type WorkflowCommandKind = 'message' | 'named_action' | 'resume_interrupt';

export interface WorkflowBridgeInput {
  commandId: string;
  userId: string;
  contextId: string;
  routeId: string;
  threadId: string;
  stageKey: string;
  baseCheckpointVersion: number;
  kind: WorkflowCommandKind;
  actionKey?: string;
  interruptId?: string;
  interruptCursor?: unknown;
  content: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  stages: StageProjection[];
}

export interface WorkflowStageSignal {
  stageKey: string;
  status: RouteStageStatus;
  internalState: string;
}

export interface WorkflowBridgeResult {
  reply: string;
  stageSignals: WorkflowStageSignal[];
  workflowCursor: unknown | null;
  memoryProposals: unknown[];
  interrupt: { prompt: string; cursor: unknown } | null;
}

export interface WorkflowBridge {
  run(input: WorkflowBridgeInput): Promise<WorkflowBridgeResult>;
}

export class WorkflowBridgeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'WorkflowBridgeError';
  }
}

const stageSignalSchema = z.object({
  stage_key: z.string(),
  status: z.enum(['not_started', 'active', 'completed']),
  internal_state: z.string(),
}).strict();

const responseSchema = z.object({
  ok: z.boolean(),
  reply: z.string().optional(),
  stage_signal: stageSignalSchema.optional(),
  stage_signals: z.array(stageSignalSchema).optional(),
  workflow_cursor: z.unknown().optional(),
  memory_proposals: z.array(z.unknown()).optional(),
  memory_delta: z.object({
    session: z.record(z.string(), z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough();

const publicMemoryProposalSchema = z.object({
  scope: z.enum(['user', 'context', 'route', 'stage', 'thread']),
  key: z.string().min(1).max(200).optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
}).strict();

const maximumResponseBytes = 2_000_000;

const statusRank: Record<RouteStageStatus, number> = {
  not_started: 0,
  active: 1,
  completed: 2,
};

function fail(code: string): never {
  throw new WorkflowBridgeError(code);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

async function readBoundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) fail('WORKFLOW_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > maximumResponseBytes) {
        await reader.cancel();
        fail('WORKFLOW_INVALID_RESPONSE');
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function validateSignals(
  input: WorkflowBridgeInput,
  manifest: ProductManifest,
  rawSignals: Array<z.infer<typeof stageSignalSchema>>,
): WorkflowStageSignal[] {
  if (input.kind !== 'named_action' && rawSignals.length > 0) fail('WORKFLOW_INVALID_STATE');

  const definitions = new Map(manifest.stages.map((stage, position) => [stage.key, { stage, position }]));
  const current = [...input.stages].sort((left, right) => left.position - right.position);
  if (current.length !== manifest.stages.length) fail('WORKFLOW_INVALID_STATE');
  const next = current.map((stage, position) => {
    const definition = manifest.stages[position];
    if (!definition || stage.stageKey !== definition.key || stage.position !== position) {
      fail('WORKFLOW_INVALID_STATE');
    }
    return { ...stage };
  });

  let movedForward = false;
  const seen = new Set<string>();
  const normalized = rawSignals.map((signal) => {
    const definition = definitions.get(signal.stage_key);
    if (!definition || seen.has(signal.stage_key) ||
        !definition.stage.internal_states.includes(signal.internal_state)) {
      fail('WORKFLOW_INVALID_STATE');
    }
    seen.add(signal.stage_key);
    const projection = next[definition.position]!;
    if (statusRank[signal.status] < statusRank[projection.status]) fail('WORKFLOW_INVALID_STATE');
    if (statusRank[signal.status] > statusRank[projection.status]) movedForward = true;
    projection.status = signal.status;
    projection.internalState = signal.internal_state;
    return {
      stageKey: signal.stage_key,
      status: signal.status,
      internalState: signal.internal_state,
    };
  });

  let activeSeen = false;
  let notStartedSeen = false;
  for (const projection of next) {
    if (projection.status === 'completed') {
      if (activeSeen || notStartedSeen) fail('WORKFLOW_INVALID_STATE');
    } else if (projection.status === 'active') {
      if (activeSeen || notStartedSeen) fail('WORKFLOW_INVALID_STATE');
      activeSeen = true;
    } else {
      notStartedSeen = true;
    }
  }
  if (input.kind === 'named_action' && input.actionKey === 'advance' && !movedForward) {
    fail('WORKFLOW_INVALID_STATE');
  }
  return normalized;
}

export function createWorkflowBridge(options: {
  endpoint: string;
  workflowId: string;
  manifest: ProductManifest;
  timeoutMs: number;
  fetch?: typeof fetch;
}): WorkflowBridge {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async run(input) {
      const signal = AbortSignal.timeout(options.timeoutMs);
      const session: Record<string, unknown> = { thread_id: input.threadId };
      if (input.kind === 'resume_interrupt') {
        if (input.interruptCursor === undefined) fail('WORKFLOW_INVALID_STATE');
        session.polarflow_pending_run = input.interruptCursor;
      }
      const body = {
        userId: input.userId,
        scenarioId: input.contextId,
        sessionId: input.threadId,
        message: input.content.trim(),
        history: input.history,
        memoryPayload: {
          user: { proposals: [] },
          context: { id: input.contextId, proposals: [] },
          route: {
            id: input.routeId,
            stages: input.stages.map((stage) => ({
              stage_key: stage.stageKey,
              status: stage.status,
              internal_state: stage.internalState,
            })),
          },
          stage: { key: input.stageKey },
          session,
        },
        workflowId: options.workflowId,
        input: {
          command_id: input.commandId,
          route_id: input.routeId,
          stage_key: input.stageKey,
          checkpoint_version: input.baseCheckpointVersion,
          command_kind: input.kind,
          ...(input.kind === 'named_action' ? { named_action: input.actionKey } : {}),
          ...(input.kind === 'resume_interrupt' ? { interrupt_id: input.interruptId } : {}),
        },
      };

      let upstream: Response;
      try {
        upstream = await fetchImpl(options.endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'Idempotency-Key': input.commandId,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (isAbort(error)) fail('WORKFLOW_TIMEOUT');
        fail('WORKFLOW_UNAVAILABLE');
      }
      if (!upstream.ok) fail('WORKFLOW_UNAVAILABLE');

      let raw: unknown;
      try {
        const text = await readBoundedText(upstream, signal);
        raw = JSON.parse(text);
      } catch (error) {
        if (error instanceof WorkflowBridgeError) throw error;
        if (signal.aborted || isAbort(error)) fail('WORKFLOW_TIMEOUT');
        fail('WORKFLOW_INVALID_RESPONSE');
      }
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success || typeof parsed.data.reply !== 'string' || !parsed.data.reply.trim()) {
        fail('WORKFLOW_INVALID_RESPONSE');
      }
      if (!parsed.data.ok) fail('WORKFLOW_REJECTED');
      const rawSignals = parsed.data.stage_signals ??
        (parsed.data.stage_signal ? [parsed.data.stage_signal] : []);
      const stageSignals = validateSignals(input, options.manifest, rawSignals);
      const pendingRun = parsed.data.memory_delta?.session?.polarflow_pending_run;
      const interrupt = pendingRun === undefined
        ? null
        : { prompt: parsed.data.reply.trim(), cursor: pendingRun };
      const memoryProposals = (parsed.data.memory_proposals ?? []).flatMap((proposal) => {
        const publicProposal = publicMemoryProposalSchema.safeParse(proposal);
        return publicProposal.success ? [publicProposal.data] : [];
      });
      return {
        reply: parsed.data.reply.trim(),
        stageSignals,
        workflowCursor: parsed.data.workflow_cursor ?? null,
        memoryProposals,
        interrupt,
      };
    },
  };
}
