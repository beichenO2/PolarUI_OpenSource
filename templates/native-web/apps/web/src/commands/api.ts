export class CommandApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = 'CommandApiError';
  }
}

export interface WorkflowMessage {
  id: string;
  commandId: string;
  role: 'user' | 'assistant';
  content: string;
  sequence: number;
  createdAt: string;
}

export interface PublicWorkflowInterrupt {
  id: string;
  prompt: string;
  actionKey?: string | null;
  createdAt?: string;
}

export interface ConversationMessages {
  messages: WorkflowMessage[];
  pendingInterrupt: PublicWorkflowInterrupt | null;
}

/** @deprecated Use ConversationMessages. */
export type ThreadMessages = ConversationMessages;

interface CommandBase {
  commandId: string;
  content: string;
  baseCheckpointId: string;
  expectedCheckpointVersion: number;
}

export type CommandInput =
  | (CommandBase & { kind: 'message' })
  | (CommandBase & { kind: 'named_action'; actionKey: string })
  | (CommandBase & { kind: 'resume_interrupt'; interruptId: string });

export type PublicCommandInput = {
  commandId: string;
  contextId?: string;
  routeId?: string;
  conversationId?: string;
  baseCheckpointId?: string;
  expectedCheckpointVersion?: number;
  input:
    | { type: 'message'; content: string }
    | { type: 'named_intent'; key: string; content?: string }
    | { type: 'resume_interrupt'; interruptId: string; content: string };
  attachmentIds: string[];
};

export interface CommandReceipt {
  commandId: string;
  eventUrl: string;
}

export interface CommandAcceptedPayload {
  commandId?: string;
  [key: string]: unknown;
}

export interface WorkflowStartedPayload {
  [key: string]: unknown;
}

export interface AssistantDeltaPayload {
  delta: string;
  [key: string]: unknown;
}

export interface WorkspaceCommittedPayload {
  contextId?: string;
  routeId?: string;
  conversationId?: string;
  checkpointId?: string | null;
  stageProjectionRevision?: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  pendingInterrupt?: PublicWorkflowInterrupt | null;
}

export type CommandOutcome = 'succeeded' | 'failed' | 'conflict';

export interface CommandFinishedPayload {
  outcome: CommandOutcome;
  code?: string;
  contextId?: string;
  routeId?: string;
  conversationId?: string;
  checkpointId?: string | null;
  stageProjectionRevision?: string;
  currentHeadCheckpointId?: string;
}

export type WorkflowCommandEvent =
  | { id: number; type: 'command.accepted'; payload: CommandAcceptedPayload }
  | { id: number; type: 'workflow.started'; payload: WorkflowStartedPayload }
  | { id: number; type: 'assistant.delta'; payload: AssistantDeltaPayload }
  | { id: number; type: 'workspace.committed'; payload: WorkspaceCommittedPayload }
  | { id: number; type: 'command.finished'; payload: CommandFinishedPayload };

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface StreamCommandOptions extends RequestOptions {
  afterEventId?: number;
}

const eventTypes = new Set<WorkflowCommandEvent['type']>([
  'command.accepted',
  'workflow.started',
  'assistant.delta',
  'workspace.committed',
  'command.finished',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function streamInvalid(status = 200): never {
  throw new CommandApiError('COMMAND_STREAM_INVALID', status);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.code !== 'string') {
    return 'REQUEST_FAILED';
  }
  return body.error.code;
}

function validMessage(value: unknown): value is WorkflowMessage {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.commandId === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' &&
    Number.isSafeInteger(value.sequence) &&
    typeof value.createdAt === 'string';
}

function validInterrupt(value: unknown): value is PublicWorkflowInterrupt {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.prompt !== 'string') return false;
  if (value.actionKey !== undefined && value.actionKey !== null && typeof value.actionKey !== 'string') {
    return false;
  }
  return value.createdAt === undefined || typeof value.createdAt === 'string';
}

function validConversationMessages(value: unknown): value is ConversationMessages {
  return isRecord(value) &&
    Array.isArray(value.messages) && value.messages.every(validMessage) &&
    (value.pendingInterrupt === null || validInterrupt(value.pendingInterrupt));
}

function validReceipt(value: unknown, expectedCommandId: string): value is CommandReceipt {
  return isRecord(value) &&
    value.commandId === expectedCommandId &&
    value.eventUrl === `/api/commands/${encodeURIComponent(expectedCommandId)}/events`;
}

async function requestMessages(
  url: string,
  options: RequestOptions = {},
): Promise<ConversationMessages> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    signal: options.signal,
  });
  const body = await readJson(response);
  if (!response.ok) throw new CommandApiError(errorCode(body), response.status);
  if (!validConversationMessages(body)) throw new CommandApiError('COMMAND_RESPONSE_INVALID', response.status);
  return body;
}

export async function listConversationMessages(
  conversationId: string,
  options: RequestOptions = {},
): Promise<ConversationMessages> {
  return requestMessages(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    options,
  );
}

async function requestReceipt(
  url: string,
  input: unknown,
  expectedCommandId: string,
  options: RequestOptions = {},
): Promise<CommandReceipt> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: options.signal,
  });
  const body = await readJson(response);
  if (!response.ok) throw new CommandApiError(errorCode(body), response.status);
  if (response.status !== 202 || !validReceipt(body, expectedCommandId)) {
    throw new CommandApiError('COMMAND_RESPONSE_INVALID', response.status);
  }
  return body;
}

export async function createWorkflowCommand(
  input: PublicCommandInput,
  options: RequestOptions = {},
) {
  return requestReceipt('/api/workflow/commands', input, input.commandId, options);
}

/** @deprecated Transitional adapter for components replaced in Task 8. */
export function listThreadMessages(
  threadId: string,
  options: RequestOptions = {},
) {
  return requestMessages(
    `/api/threads/${encodeURIComponent(threadId)}/messages`,
    options,
  );
}

/** @deprecated Transitional adapter for components replaced in Task 8. */
export function createCommand(
  threadId: string,
  input: CommandInput,
  options: RequestOptions = {},
) {
  return requestReceipt(
    `/api/threads/${encodeURIComponent(threadId)}/commands`,
    input,
    input.commandId,
    options,
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function canonicalValue(
  payload: Record<string, unknown>,
  canonicalKey: string,
  legacyKey?: string,
  nullable = false,
): string | null | undefined {
  const canonical = payload[canonicalKey];
  const legacy = legacyKey ? payload[legacyKey] : undefined;
  const valid = (value: unknown) => value === undefined || typeof value === 'string' || (nullable && value === null);
  if (!valid(canonical) || !valid(legacy)) streamInvalid();
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) streamInvalid();
  return (canonical !== undefined ? canonical : legacy) as string | null | undefined;
}

function optionalInterrupt(value: unknown): PublicWorkflowInterrupt | null | undefined {
  if (value === undefined || value === null) return value;
  if (!validInterrupt(value)) streamInvalid();
  return value;
}

function normalizeWorkspacePayload(payload: Record<string, unknown>): WorkspaceCommittedPayload {
  if (Object.prototype.hasOwnProperty.call(payload, 'stageKey')) streamInvalid();
  const normalized: WorkspaceCommittedPayload = {};
  const contextId = canonicalValue(payload, 'contextId', 'resultContextId');
  const routeId = canonicalValue(payload, 'routeId', 'resultRouteId');
  const conversationId = canonicalValue(payload, 'conversationId', 'resultThreadId');
  const checkpointId = canonicalValue(payload, 'checkpointId', 'resultCheckpointId', true);
  const stageProjectionRevision = canonicalValue(payload, 'stageProjectionRevision');
  const userMessageId = canonicalValue(payload, 'userMessageId', undefined, true);
  const assistantMessageId = canonicalValue(payload, 'assistantMessageId', undefined, true);
  const pendingInterrupt = optionalInterrupt(payload.pendingInterrupt);
  if (contextId !== undefined) normalized.contextId = contextId;
  if (routeId !== undefined) normalized.routeId = routeId;
  if (conversationId !== undefined) normalized.conversationId = conversationId;
  if (checkpointId !== undefined) normalized.checkpointId = checkpointId;
  if (stageProjectionRevision !== undefined) normalized.stageProjectionRevision = stageProjectionRevision;
  if (userMessageId !== undefined) normalized.userMessageId = userMessageId;
  if (assistantMessageId !== undefined) normalized.assistantMessageId = assistantMessageId;
  if (pendingInterrupt !== undefined) normalized.pendingInterrupt = pendingInterrupt;
  return normalized;
}

function validatePayload(
  type: WorkflowCommandEvent['type'],
  payload: Record<string, unknown>,
): WorkflowCommandEvent['payload'] {
  if (type === 'assistant.delta' && typeof payload.delta !== 'string') streamInvalid();
  if (type === 'workspace.committed') return normalizeWorkspacePayload(payload);
  if (type === 'command.finished') {
    if (payload.outcome !== 'succeeded' && payload.outcome !== 'failed' && payload.outcome !== 'conflict') {
      streamInvalid();
    }
    const code = canonicalValue(payload, 'code');
    const currentHeadCheckpointId = canonicalValue(payload, 'currentHeadCheckpointId');
    const workspace = normalizeWorkspacePayload(payload);
    return {
      outcome: payload.outcome,
      ...(code !== undefined ? { code } : {}),
      ...workspace,
      ...(currentHeadCheckpointId !== undefined ? { currentHeadCheckpointId } : {}),
    } as CommandFinishedPayload;
  }
  return payload as WorkflowCommandEvent['payload'];
}

function parseFrame(frame: string, lastEventId: number): WorkflowCommandEvent | null {
  let rawId: string | undefined;
  let rawType: string | undefined;
  let rawData: string | undefined;

  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    if (separator < 0) streamInvalid();
    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, '');
    if (field === 'id') {
      if (rawId !== undefined) streamInvalid();
      rawId = value;
    } else if (field === 'event') {
      if (rawType !== undefined) streamInvalid();
      rawType = value;
    } else if (field === 'data') {
      if (rawData !== undefined) streamInvalid();
      rawData = value;
    } else {
      streamInvalid();
    }
  }

  if (rawId === undefined && rawType === undefined && rawData === undefined) return null;
  if (rawId === undefined || rawType === undefined || rawData === undefined) streamInvalid();
  if (!/^[1-9]\d*$/.test(rawId)) streamInvalid();
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= lastEventId || !eventTypes.has(rawType as WorkflowCommandEvent['type'])) {
    streamInvalid();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawData);
  } catch {
    streamInvalid();
  }
  if (!isRecord(payload)) streamInvalid();
  const type = rawType as WorkflowCommandEvent['type'];
  return { id, type, payload: validatePayload(type, payload) } as WorkflowCommandEvent;
}

export async function streamCommandEvents(
  eventUrl: string,
  options: StreamCommandOptions,
  onEvent: (event: WorkflowCommandEvent) => void,
): Promise<{ lastEventId: number; finished: CommandFinishedPayload }> {
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (options.afterEventId !== undefined) {
    if (!Number.isSafeInteger(options.afterEventId) || options.afterEventId < 0) streamInvalid();
    headers['Last-Event-ID'] = String(options.afterEventId);
  }
  const response = await fetch(eventUrl, {
    method: 'GET',
    credentials: 'same-origin',
    headers,
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await readJson(response);
    throw new CommandApiError(errorCode(body), response.status);
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    streamInvalid(response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastEventId = options.afterEventId ?? 0;
  const abort = () => { void reader.cancel(options.signal ? abortReason(options.signal) : undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    if (options.signal?.aborted) {
      await reader.cancel(abortReason(options.signal));
      throw abortReason(options.signal);
    }
    while (true) {
      const { done, value } = await reader.read();
      if (options.signal?.aborted) throw abortReason(options.signal);
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const frameText = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const event = parseFrame(frameText, lastEventId);
        if (event) {
          lastEventId = event.id;
          onEvent(event);
          if (event.type === 'command.finished') {
            await reader.cancel();
            return { lastEventId, finished: event.payload };
          }
        }
        separator = /\r?\n\r?\n/.exec(buffer);
      }

      if (done) {
        if (buffer.trim()) streamInvalid(response.status);
        streamInvalid(response.status);
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
