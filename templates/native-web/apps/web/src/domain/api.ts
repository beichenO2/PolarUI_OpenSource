export class DomainApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

export type PublicScopeStatus = 'initializing' | 'active' | 'archived';
export type StageStatus = 'not_started' | 'active' | 'completed';
export type ThreadStatus = PublicScopeStatus;

export interface WorkflowContext {
  id: string;
  title: string;
  status: PublicScopeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRoute {
  id: string;
  contextId: string;
  name: string;
  originCheckpointId: string | null;
  origin?: {
    routeId: string;
    routeName: string;
    version: number;
    stageKey: string | null;
  } | null;
  headCheckpointId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StageProjection {
  stageKey: string;
  position: number;
  status: StageStatus;
  internalState: string;
  label: string;
}

export interface StageProjectionSnapshot {
  revision: string;
  items: Array<{
    key: string;
    label: string;
    status: string;
    checkpointId?: string;
    summary?: string;
  }>;
}

export interface CheckpointArtifact {
  id: string;
  stage_key: string | null;
  filename: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  created_at: string;
}

export interface WorkflowCheckpoint {
  id: string;
  contextId: string;
  routeId: string;
  parentCheckpointId: string | null;
  version: number;
  stageKey: string | null;
  reason: 'bootstrap' | 'branch' | 'workflow_action';
  snapshot: {
    workflowState: Record<string, unknown>;
    workflowRevision?: string;
    sourceCommandId?: string;
    stageProjection?: StageProjectionSnapshot;
    memoryReferences: Array<{ memoryId: string; version: number }>;
    artifacts: CheckpointArtifact[];
    stages?: Array<{ stage_key: string; status: StageStatus; internal_state: string }>;
  };
  createdAt: string;
}

export interface WorkflowThread {
  id: string;
  contextId: string;
  routeId: string;
  stageKey: string;
  title: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowConversation {
  id: string;
  contextId: string;
  routeId: string;
  title: string;
  titleSource: 'agent' | 'user';
  isPrimary: boolean;
  status: PublicScopeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ContextWorkspace {
  context: WorkflowContext;
  routes: WorkflowRoute[];
}

export interface RouteWorkspace {
  context: WorkflowContext;
  route: WorkflowRoute;
  checkpoints: WorkflowCheckpoint[];
  conversations: WorkflowConversation[];
  selectedCheckpoint: WorkflowCheckpoint;
  headCheckpoint: WorkflowCheckpoint;
  isHistorical: boolean;
  artifacts: CheckpointArtifact[];
  stageProjection?: StageProjectionSnapshot;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new DomainApiError(body?.error?.code ?? 'REQUEST_FAILED', response.status);
  return body as T;
}

export const listContexts = () => request<{ contexts: WorkflowContext[] }>('/api/contexts');

export const createContext = (title: string) => request<{
  context: WorkflowContext;
  route: WorkflowRoute;
  checkpoint: WorkflowCheckpoint;
}>('/api/contexts', { method: 'POST', body: JSON.stringify({ title }) });

export const getContextWorkspace = (contextId: string) =>
  request<ContextWorkspace>(`/api/contexts/${encodeURIComponent(contextId)}/workspace`);

export const getRouteWorkspace = (routeId: string, checkpointId?: string) =>
  request<RouteWorkspace>(
    `/api/routes/${encodeURIComponent(routeId)}/workspace${
      checkpointId ? `?checkpoint=${encodeURIComponent(checkpointId)}` : ''
    }`,
  );

export const renameContext = (contextId: string, input: { title: string }) =>
  request<WorkflowContext>(`/api/contexts/${encodeURIComponent(contextId)}`, {
    method: 'PATCH', body: JSON.stringify(input),
  });

export const createConversation = (routeId: string) =>
  request<WorkflowConversation>(`/api/routes/${encodeURIComponent(routeId)}/conversations`, {
    method: 'POST', body: '{}',
  });

export const updateConversation = (
  conversationId: string,
  input: { title?: string; status?: 'active' | 'archived' },
) => request<WorkflowConversation>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
  method: 'PATCH', body: JSON.stringify(input),
});

/** @deprecated Transitional Stage/Thread client retained until Task 7 replaces App state. */
export const createThread = (routeId: string, input: { stageKey: string; title: string }) =>
  request<WorkflowThread>(`/api/routes/${encodeURIComponent(routeId)}/threads`, {
    method: 'POST', body: JSON.stringify(input),
  });

export const updateThread = (threadId: string, input: { title?: string; status?: ThreadStatus }) =>
  request<WorkflowThread>(`/api/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH', body: JSON.stringify(input),
  });

export const createRouteFromVersion = (
  contextId: string,
  input: { sourceCheckpointId: string; name: string },
) => request<{ route: WorkflowRoute; checkpoint: WorkflowCheckpoint }>(
  `/api/contexts/${encodeURIComponent(contextId)}/routes`,
  { method: 'POST', body: JSON.stringify(input) },
);
