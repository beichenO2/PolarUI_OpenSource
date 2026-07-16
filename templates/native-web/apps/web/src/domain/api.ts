export class DomainApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

export type StageStatus = 'not_started' | 'active' | 'completed';
export type ThreadStatus = 'active' | 'archived';

export interface WorkflowContext {
  id: string;
  title: string;
  status: 'active' | 'archived';
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
    stageKey: string;
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
  componentKey: string;
}

export interface WorkflowCheckpoint {
  id: string;
  contextId: string;
  routeId: string;
  parentCheckpointId: string | null;
  version: number;
  stageKey: string;
  reason: 'bootstrap' | 'branch' | 'workflow_action';
  snapshot: {
    stages: Array<{ stage_key: string; status: StageStatus; internal_state: string }>;
    artifacts?: Array<{
      id: string;
      stage_key: string;
      filename: string;
      media_type: string;
      byte_size: number;
      sha256: string;
      created_at: string;
    }>;
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

export interface ContextWorkspace {
  context: WorkflowContext;
  routes: WorkflowRoute[];
}

export interface RouteWorkspace {
  context: WorkflowContext;
  route: WorkflowRoute;
  stages: StageProjection[];
  checkpoints: WorkflowCheckpoint[];
  threads: WorkflowThread[];
  selectedStageKey: string;
  selectedCheckpoint: WorkflowCheckpoint;
  isHistorical: boolean;
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

export function getRouteWorkspace(routeId: string, stageKey: string) {
  const query = new URLSearchParams({ stage: stageKey });
  return request<RouteWorkspace>(
    `/api/routes/${encodeURIComponent(routeId)}/workspace?${query.toString()}`,
  );
}

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
