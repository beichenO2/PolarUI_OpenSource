import type { ProductManifest } from '@polar/native-web-product-sdk';
import { z } from 'zod';
import { readFile, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type {
  CheckpointSnapshot,
  CheckpointWorkflowState,
  RouteStageStatus,
  StageProjection,
  StageProjectionSnapshot,
} from '../domain/types.js';
import type { PublicWorkflowCommandInput } from './types.js';

export type WorkflowCommandKind = 'message' | 'named_action' | 'resume_interrupt';

export interface LegacyWorkflowBridgeInput {
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

export interface WorkflowV2BridgeInput {
  commandId: string;
  userId: string;
  contextId: string;
  routeId: string;
  conversationId: string;
  baseCheckpoint: {
    id: string;
    version: number;
    snapshot: CheckpointSnapshot;
  };
  commandInput: PublicWorkflowCommandInput;
  interruptCursor?: unknown;
  attachments: unknown[];
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  memory: { user: unknown[]; context: unknown[] };
}

export type WorkflowBridgeInput = LegacyWorkflowBridgeInput | WorkflowV2BridgeInput;

export interface WorkflowStageSignal {
  stageKey: string;
  status: RouteStageStatus;
  internalState: string;
}

export interface ArtifactProposal {
  filename: string;
  mediaType: string;
  body: Buffer;
}

export interface MemoryUpdate {
  scope: 'user' | 'context';
  key: string;
  value: unknown;
  expectedVersion?: number;
  highImpact?: boolean;
  confirmationPrompt?: string;
  evidence?: Array<Record<string, unknown>>;
  impactScope?: Record<string, unknown>;
}

export interface LegacyWorkflowBridgeResult {
  reply: string;
  stageSignals: WorkflowStageSignal[];
  workflowCursor: unknown | null;
  memoryProposals: unknown[];
  interrupt: { prompt: string; cursor: unknown } | null;
  artifactProposals: ArtifactProposal[];
}

export interface WorkflowV2BridgeResult {
  replyEvents: Array<{ type: 'delta' | 'message'; content: string }>;
  checkpoint: { workflowState: CheckpointWorkflowState };
  stageProjection?: StageProjectionSnapshot;
  contextTitle?: string;
  conversationTitle?: string;
  memoryUpdates: MemoryUpdate[];
  artifactProposals: ArtifactProposal[];
  interrupt: { prompt: string; cursor: unknown } | null;
  diagnostics: Record<string, unknown>;
}

export type WorkflowBridgeResult = LegacyWorkflowBridgeResult | WorkflowV2BridgeResult;

export interface WorkflowBridge {
  run(input: WorkflowV2BridgeInput): Promise<WorkflowV2BridgeResult>;
  run(input: LegacyWorkflowBridgeInput): Promise<LegacyWorkflowBridgeResult>;
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

const artifactProposalSchema = z.object({
  filename: z.string().min(1).max(255),
  media_type: z.string().min(3).max(200),
  content_base64: z.string().min(1).max(35_000_000),
}).strict();

const responseSchema = z.object({
  ok: z.boolean(),
  reply: z.string().optional(),
  stage_signal: stageSignalSchema.optional(),
  stage_signals: z.array(stageSignalSchema).optional(),
  workflow_cursor: z.unknown().optional(),
  memory_proposals: z.array(z.unknown()).optional(),
  artifact_proposals: z.array(artifactProposalSchema).max(10).optional(),
  memory_delta: z.object({
    session: z.record(z.string(), z.unknown()).optional(),
  }).passthrough().optional(),
  pdf_path: z.string().min(1).nullable().optional(),
}).passthrough();

const stageProjectionSchema = z.object({
  revision: z.string().trim().min(1).max(200),
  items: z.array(z.object({
    key: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(200),
    status: z.string().trim().min(1).max(200),
    checkpoint_id: z.string().uuid().optional(),
    summary: z.string().max(2000).optional(),
  }).strict()).max(1000),
}).strict();

const memoryUpdateSchema = z.object({
  scope: z.enum(['user', 'context']),
  key: z.string().trim().min(1).max(200),
  value: z.unknown(),
  expected_version: z.number().int().min(1).optional(),
  high_impact: z.boolean().optional(),
  confirmation_prompt: z.string().trim().min(1).max(2000).optional(),
  evidence: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
  impact_scope: z.record(z.string(), z.unknown()).optional(),
}).strict().refine((update) => Object.hasOwn(update, 'value'), {
  message: 'memory update value is required',
});

const interruptSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  cursor: z.unknown(),
}).strict().refine((interrupt) => Object.hasOwn(interrupt, 'cursor'), {
  message: 'interrupt cursor is required',
});

const v2ResponseSchema = z.object({
  contract_version: z.literal('2.0'),
  reply_events: z.array(z.object({
    type: z.enum(['delta', 'message']),
    content: z.string().min(1).max(20_000),
  }).strict()).max(1000),
  checkpoint: z.object({
    workflow_state: z.record(z.string(), z.unknown()),
  }).strict(),
  stage_projection: stageProjectionSchema.optional(),
  context_title: z.string().trim().min(1).max(120).optional(),
  conversation_title: z.string().trim().min(1).max(120).optional(),
  memory_updates: z.array(memoryUpdateSchema).max(1000).default([]),
  artifact_proposals: z.array(artifactProposalSchema).max(10).default([]),
  interrupt: interruptSchema.nullable().default(null),
  diagnostics: z.record(z.string(), z.unknown()).default({}),
}).passthrough().superRefine((result, context) => {
  if (result.reply_events.length === 0 && result.interrupt === null) {
    context.addIssue({ code: 'custom', message: 'reply events or interrupt required' });
  }
});

const USER_MEMORY_GOAL = '是对用户的建模，能揭示用户的习惯、特点、taste。';
const CONTEXT_MEMORY_GOAL = '是对本情景的建模，是本情景的本质信息；对之后处理具体问题有持续性帮助或约束。';

const publicMemoryProposalSchema = z.object({
  scope: z.enum(['user', 'context', 'route', 'stage', 'thread']),
  key: z.string().min(1).max(200).optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
}).strict();

const maximumResponseBytes = 36_000_000;

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
  input: LegacyWorkflowBridgeInput,
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

function normalizeArtifacts(
  proposals: Array<z.infer<typeof artifactProposalSchema>>,
): ArtifactProposal[] {
  return proposals.map((proposal) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(proposal.content_base64) ||
        proposal.content_base64.length % 4 !== 0) {
      fail('WORKFLOW_INVALID_ARTIFACT');
    }
    const body = Buffer.from(proposal.content_base64, 'base64');
    if (body.byteLength === 0 || body.byteLength > 25 * 1024 * 1024 ||
        body.toString('base64') !== proposal.content_base64) {
      fail('WORKFLOW_INVALID_ARTIFACT');
    }
    return { filename: proposal.filename, mediaType: proposal.media_type, body };
  });
}

function normalizeProjection(
  projection: z.infer<typeof stageProjectionSchema> | undefined,
): StageProjectionSnapshot | undefined {
  if (!projection) return undefined;
  const keys = new Set<string>();
  const items = projection.items.map((item) => {
    if (keys.has(item.key)) fail('WORKFLOW_INVALID_RESPONSE');
    keys.add(item.key);
    return {
      key: item.key,
      label: item.label,
      status: item.status,
      ...(item.checkpoint_id === undefined ? {} : { checkpointId: item.checkpoint_id }),
      ...(item.summary === undefined ? {} : { summary: item.summary }),
    };
  });
  return { revision: projection.revision, items };
}

function normalizeMemoryUpdates(
  updates: Array<z.infer<typeof memoryUpdateSchema>>,
): MemoryUpdate[] {
  return updates.map((update) => ({
    scope: update.scope,
    key: update.key,
    value: update.value,
    ...(update.expected_version === undefined ? {} : { expectedVersion: update.expected_version }),
    ...(update.high_impact === undefined ? {} : { highImpact: update.high_impact }),
    ...(update.confirmation_prompt === undefined
      ? {}
      : { confirmationPrompt: update.confirmation_prompt }),
    ...(update.evidence === undefined ? {} : { evidence: update.evidence }),
    ...(update.impact_scope === undefined ? {} : { impactScope: update.impact_scope }),
  }));
}

function publicDiagnostics(diagnostics: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof diagnostics.workflow_revision === 'string' &&
      diagnostics.workflow_revision.length > 0 && diagnostics.workflow_revision.length <= 200) {
    result.workflow_revision = diagnostics.workflow_revision;
  }
  if (typeof diagnostics.duration_ms === 'number' && Number.isFinite(diagnostics.duration_ms) &&
      diagnostics.duration_ms >= 0 && diagnostics.duration_ms <= 86_400_000) {
    result.duration_ms = diagnostics.duration_ms;
  }
  return result;
}

export function createWorkflowBridge(options: {
  endpoint: string;
  workflowId: string;
  manifest: ProductManifest;
  timeoutMs: number;
  fetch?: typeof fetch;
  artifactRoot?: string | null;
}): WorkflowBridge {
  const fetchImpl = options.fetch ?? fetch;

  async function request(commandId: string, body: unknown): Promise<unknown> {
    const signal = AbortSignal.timeout(options.timeoutMs);
    let upstream: Response;
    try {
      upstream = await fetchImpl(options.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'Idempotency-Key': commandId,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbort(error)) fail('WORKFLOW_TIMEOUT');
      fail('WORKFLOW_UNAVAILABLE');
    }
    if (!upstream.ok) fail('WORKFLOW_UNAVAILABLE');
    try {
      const text = await readBoundedText(upstream, signal);
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof WorkflowBridgeError) throw error;
      if (signal.aborted || isAbort(error)) fail('WORKFLOW_TIMEOUT');
      fail('WORKFLOW_INVALID_RESPONSE');
    }
  }

  async function run(input: WorkflowV2BridgeInput): Promise<WorkflowV2BridgeResult>;
  async function run(input: LegacyWorkflowBridgeInput): Promise<LegacyWorkflowBridgeResult>;
  async function run(input: WorkflowBridgeInput): Promise<WorkflowBridgeResult> {
      if ('commandInput' in input) {
        if (input.commandInput.type === 'resume_interrupt' && input.interruptCursor === undefined) {
          fail('WORKFLOW_INVALID_STATE');
        }
        const raw = await request(input.commandId, {
          contract_version: '2.0',
          command: {
            id: input.commandId,
            context_id: input.contextId,
            route_id: input.routeId,
            conversation_id: input.conversationId,
            base_checkpoint_id: input.baseCheckpoint.id,
            expected_checkpoint_version: input.baseCheckpoint.version,
            input: input.commandInput,
            attachments: input.attachments,
          },
          history: input.history,
          memory: {
            user: {
              items: input.memory.user,
              extraction_goal: USER_MEMORY_GOAL,
            },
            context: {
              items: input.memory.context,
              extraction_goal: CONTEXT_MEMORY_GOAL,
            },
          },
          ...(input.commandInput.type === 'resume_interrupt'
            ? { interrupt_cursor: input.interruptCursor }
            : {}),
          checkpoint_snapshot: input.baseCheckpoint.snapshot,
          workflow_id: options.workflowId,
        });
        const parsed = v2ResponseSchema.safeParse(raw);
        if (!parsed.success) fail('WORKFLOW_INVALID_RESPONSE');
        const projection = normalizeProjection(parsed.data.stage_projection);
        return {
          replyEvents: parsed.data.reply_events,
          checkpoint: { workflowState: parsed.data.checkpoint.workflow_state },
          ...(projection === undefined ? {} : { stageProjection: projection }),
          ...(parsed.data.context_title === undefined ? {} : { contextTitle: parsed.data.context_title }),
          ...(parsed.data.conversation_title === undefined
            ? {}
            : { conversationTitle: parsed.data.conversation_title }),
          memoryUpdates: normalizeMemoryUpdates(parsed.data.memory_updates),
          artifactProposals: normalizeArtifacts(parsed.data.artifact_proposals),
          interrupt: parsed.data.interrupt,
          diagnostics: publicDiagnostics(parsed.data.diagnostics),
        };
      }

      const session: Record<string, unknown> = { thread_id: input.threadId };
      if (input.kind === 'resume_interrupt') {
        if (input.interruptCursor === undefined) fail('WORKFLOW_INVALID_STATE');
        session.polarflow_pending_run = input.interruptCursor;
      }
      const body = {
        contract_version: '1.0',
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
          contract_version: '1.0',
          command_id: input.commandId,
          route_id: input.routeId,
          stage_key: input.stageKey,
          checkpoint_version: input.baseCheckpointVersion,
          command_kind: input.kind,
          ...(input.kind === 'named_action' ? { named_action: input.actionKey } : {}),
          ...(input.kind === 'resume_interrupt' ? { interrupt_id: input.interruptId } : {}),
        },
      };
      const raw = await request(input.commandId, body);
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
      const artifactProposals = normalizeArtifacts(parsed.data.artifact_proposals ?? []);
      if (parsed.data.pdf_path && options.artifactRoot) {
        try {
          const root = await realpath(resolve(options.artifactRoot));
          const path = await realpath(resolve(parsed.data.pdf_path));
          if (path !== root && !path.startsWith(root + '/')) fail('WORKFLOW_INVALID_ARTIFACT');
          const body = await readFile(path);
          if (body.byteLength === 0 || body.byteLength > 25 * 1024 * 1024) fail('WORKFLOW_INVALID_ARTIFACT');
          artifactProposals.push({ filename: basename(path), mediaType: 'application/pdf', body });
        } catch (error) {
          if (error instanceof WorkflowBridgeError) throw error;
          fail('WORKFLOW_INVALID_ARTIFACT');
        }
      }
      return {
        reply: parsed.data.reply.trim(),
        stageSignals,
        workflowCursor: parsed.data.workflow_cursor ?? null,
        memoryProposals,
        interrupt,
        artifactProposals,
      };
  }

  return { run };
}
