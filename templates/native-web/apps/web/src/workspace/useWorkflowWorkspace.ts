import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import type { CommandFinishedPayload } from '../commands/api';
import {
  DomainApiError,
  getContextWorkspace,
  getRouteWorkspace,
  listContexts,
  type ContextWorkspace,
  type RouteWorkspace,
  type WorkflowContext,
  type WorkflowConversation,
  type WorkflowRoute,
} from '../domain/api';
import {
  clearComposerDraft,
  readComposerDraft,
  writeComposerDraft,
  type ComposerDraftScope,
} from '../auth/storage';

export interface WorkspaceSelection {
  contextId?: string;
  routeId?: string;
  conversationId?: string;
  checkpointId?: string;
  virtualConversationId?: string;
}

export type WorkspacePhase = 'loading' | 'empty' | 'ready' | 'initializing' | 'error';

interface UseWorkflowWorkspaceOptions {
  productId: string;
  userId: string;
  createVirtualConversationId?: () => string;
}

interface VirtualHistoryState {
  polarNativeWorkflow: {
    version: 1;
    productId: string;
    userId: string;
    virtualConversationId: string;
  };
}

function workspaceOwnerIdentity(options: Pick<UseWorkflowWorkspaceOptions, 'productId' | 'userId'>) {
  return `${encodeURIComponent(options.productId)}:${encodeURIComponent(options.userId)}`;
}

function virtualHistoryState(
  options: Pick<UseWorkflowWorkspaceOptions, 'productId' | 'userId'>,
  virtualConversationId: string,
): VirtualHistoryState {
  return {
    polarNativeWorkflow: {
      version: 1,
      productId: options.productId,
      userId: options.userId,
      virtualConversationId,
    },
  };
}

function virtualConversationFromHistory(
  value: unknown,
  options: Pick<UseWorkflowWorkspaceOptions, 'productId' | 'userId'>,
) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const state = (value as Record<string, unknown>).polarNativeWorkflow;
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return undefined;
  const candidate = state as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.productId !== options.productId ||
      candidate.userId !== options.userId || typeof candidate.virtualConversationId !== 'string' ||
      !candidate.virtualConversationId.startsWith('virtual:')) return undefined;
  return candidate.virtualConversationId;
}

const canonicalLocation = /^\/contexts\/([^/]+)\/routes\/([^/]+)(?:\/conversations\/([^/]+))?$/;

const decode = (value: string | undefined) => {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

export function parseWorkspaceLocation(locationValue: string): WorkspaceSelection {
  const url = new URL(locationValue, 'http://workflow.local');
  const match = canonicalLocation.exec(url.pathname);
  if (!match || url.searchParams.has('stage')) return {};
  const contextId = decode(match[1]);
  const routeId = decode(match[2]);
  const conversationId = decode(match[3]);
  const checkpointId = url.searchParams.get('checkpoint') ?? undefined;
  if (!contextId || !routeId || (match[3] && !conversationId)) return {};
  return {
    contextId,
    routeId,
    ...(conversationId ? { conversationId } : {}),
    ...(checkpointId ? { checkpointId } : {}),
  };
}

function selectionFromLocation(
  locationValue: string,
  historyState: unknown,
  options: Pick<UseWorkflowWorkspaceOptions, 'productId' | 'userId'>,
): WorkspaceSelection {
  const selection = parseWorkspaceLocation(locationValue);
  const virtualConversationId = virtualConversationFromHistory(historyState, options);
  if (!selection.contextId || !selection.routeId || selection.conversationId || !virtualConversationId) {
    return selection;
  }
  return { ...selection, virtualConversationId };
}

export function formatWorkspaceLocation(selection: WorkspaceSelection): string {
  if (!selection.contextId || !selection.routeId) return '/';
  const base = `/contexts/${encodeURIComponent(selection.contextId)}/routes/${encodeURIComponent(selection.routeId)}`;
  const conversation = selection.conversationId
    ? `/conversations/${encodeURIComponent(selection.conversationId)}`
    : '';
  const checkpoint = selection.checkpointId
    ? `?checkpoint=${encodeURIComponent(selection.checkpointId)}`
    : '';
  return base + conversation + checkpoint;
}

function newest<T extends { updatedAt: string }>(items: T[]): T | undefined {
  return [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function preferredContext(contexts: WorkflowContext[], requestedId?: string) {
  return contexts.find(({ id, status }) => id === requestedId && status === 'active')
    ?? newest(contexts.filter(({ status }) => status === 'active'));
}

function preferredRoute(workspace: ContextWorkspace, requestedId?: string): WorkflowRoute | undefined {
  return workspace.routes.find(({ id }) => id === requestedId) ?? newest(workspace.routes);
}

function preferredConversation(conversations: WorkflowConversation[], requestedId?: string) {
  return conversations.find(({ id, status }) => id === requestedId && status === 'active')
    ?? conversations.find(({ isPrimary, status }) => isPrimary && status === 'active')
    ?? newest(conversations.filter(({ status }) => status === 'active'));
}

function draftScope(
  options: Pick<UseWorkflowWorkspaceOptions, 'productId' | 'userId'>,
  selection: WorkspaceSelection,
): ComposerDraftScope {
  return { productId: options.productId, userId: options.userId, ...selection };
}

function attachmentOwnerKey(
  options: Pick<UseWorkflowWorkspaceOptions, 'productId' | 'userId'>,
  selection: WorkspaceSelection,
) {
  return [
    options.productId,
    options.userId,
    selection.contextId ?? 'zero-context',
    selection.routeId ?? 'zero-route',
    selection.conversationId ?? 'zero-conversation',
    selection.virtualConversationId ?? 'zero-virtual',
  ].map(encodeURIComponent).join(':');
}

export function useWorkflowWorkspace(options: UseWorkflowWorkspaceOptions) {
  const [phase, setPhase] = useState<WorkspacePhase>('loading');
  const [selection, setSelection] = useState<WorkspaceSelection>({});
  const [workspace, setWorkspace] = useState<RouteWorkspace>();
  const [draft, setDraftState] = useState('');
  const [attachmentIds, setAttachmentIdsState] = useState<string[]>([]);
  const attachmentIdsRef = useRef<string[]>([]);
  const attachmentIdsByOwner = useRef(new Map<string, string[]>());
  const generation = useRef(0);
  const currentOwnerIdentity = workspaceOwnerIdentity(options);
  const latestOwnerIdentityRef = useRef(currentOwnerIdentity);
  latestOwnerIdentityRef.current = currentOwnerIdentity;
  const workspaceOwnerRef = useRef<string>();
  const [workspaceOwner, setWorkspaceOwner] = useState<string>();
  const [identityLoading, setIdentityLoading] = useState(true);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const identityReady = workspaceOwner === currentOwnerIdentity && !identityLoading;
  const actionOwnerIsReady = useCallback(() => (
    latestOwnerIdentityRef.current === currentOwnerIdentity &&
    workspaceOwnerRef.current === currentOwnerIdentity &&
    workspaceOwner === currentOwnerIdentity &&
    !identityLoading
  ), [currentOwnerIdentity, identityLoading, workspaceOwner]);

  const installSelection = useCallback((next: WorkspaceSelection) => {
    if (latestOwnerIdentityRef.current !== currentOwnerIdentity) return;
    selectionRef.current = next;
    setSelection(next);
    setDraftState(readComposerDraft(draftScope(options, next)));
    const ownedAttachmentIds = attachmentIdsByOwner.current.get(attachmentOwnerKey(options, next)) ?? [];
    attachmentIdsRef.current = ownedAttachmentIds;
    setAttachmentIdsState(ownedAttachmentIds);
    setWorkspaceOwner(currentOwnerIdentity);
    setIdentityLoading(false);
  }, [currentOwnerIdentity, options.productId, options.userId]);

  const navigate = useCallback(async (
    requested: WorkspaceSelection,
    historyMode: 'push' | 'replace' | 'none' = 'replace',
  ) => {
    if (latestOwnerIdentityRef.current !== currentOwnerIdentity) return;
    if (workspaceOwnerRef.current !== currentOwnerIdentity) {
      workspaceOwnerRef.current = currentOwnerIdentity;
      setWorkspaceOwner(currentOwnerIdentity);
      setIdentityLoading(true);
      selectionRef.current = {};
      setSelection({});
      setWorkspace(undefined);
      setDraftState('');
      attachmentIdsRef.current = [];
      setAttachmentIdsState([]);
    }
    const currentGeneration = ++generation.current;
    const navigationIsCurrent = () => currentGeneration === generation.current &&
      latestOwnerIdentityRef.current === currentOwnerIdentity;
    setPhase('loading');
    try {
      const { contexts } = await listContexts();
      if (!navigationIsCurrent()) return;
      const context = preferredContext(contexts, requested.contextId);
      if (!context) {
        const emptySelection = { virtualConversationId: 'virtual:start' };
        setWorkspace(undefined);
        installSelection(emptySelection);
        setPhase('empty');
        if (historyMode !== 'none' && location.pathname + location.search !== '/') history.replaceState({}, '', '/');
        return;
      }

      const contextWorkspace = await getContextWorkspace(context.id);
      if (!navigationIsCurrent()) return;
      const route = preferredRoute(contextWorkspace, requested.routeId);
      if (!route) {
        const next = { contextId: context.id, virtualConversationId: `virtual:primary:${context.id}` };
        setWorkspace(undefined);
        installSelection(next);
        setPhase('initializing');
        if (historyMode !== 'none') history.replaceState({}, '', '/');
        return;
      }

      let routeWorkspace: RouteWorkspace;
      try {
        routeWorkspace = await getRouteWorkspace(route.id, requested.checkpointId);
      } catch (error) {
        if (!navigationIsCurrent()) return;
        const recoverableCheckpointLocation = error instanceof DomainApiError && (
          (error.status === 404 && error.code === 'NOT_FOUND') ||
          (error.status === 400 && error.code === 'INVALID_REQUEST')
        );
        if (!recoverableCheckpointLocation) {
          throw error;
        }
        if (!requested.checkpointId) throw error;
        routeWorkspace = await getRouteWorkspace(route.id);
      }
      if (!navigationIsCurrent()) return;
      const conversation = requested.virtualConversationId
        ? undefined
        : preferredConversation(routeWorkspace.conversations, requested.conversationId);
      const selectedCheckpointId = routeWorkspace.selectedCheckpoint.id;
      const next: WorkspaceSelection = {
        contextId: context.id,
        routeId: route.id,
        ...(requested.virtualConversationId
          ? { virtualConversationId: requested.virtualConversationId }
          : conversation
          ? { conversationId: conversation.id }
          : { virtualConversationId: `virtual:primary:${route.id}` }),
        checkpointId: selectedCheckpointId,
      };
      setWorkspace(routeWorkspace);
      installSelection(next);
      setPhase('ready');
      if (historyMode !== 'none') {
        const urlSelection = selectedCheckpointId === routeWorkspace.headCheckpoint.id
          ? { ...next, checkpointId: undefined }
          : next;
        const target = formatWorkspaceLocation(urlSelection);
        const virtualConversationId = next.virtualConversationId;
        const currentVirtualConversationId = virtualConversationFromHistory(history.state, options);
        if (target !== location.pathname + location.search ||
            currentVirtualConversationId !== virtualConversationId) {
          history[historyMode === 'push' ? 'pushState' : 'replaceState'](
            virtualConversationId ? virtualHistoryState(options, virtualConversationId) : {},
            '',
            target,
          );
        }
      }
    } catch (error) {
      if (navigationIsCurrent()) {
        setWorkspaceOwner(currentOwnerIdentity);
        setIdentityLoading(false);
        setPhase('error');
      }
    }
  }, [currentOwnerIdentity, installSelection, options.productId, options.userId]);

  useEffect(() => {
    void navigate(selectionFromLocation(location.pathname + location.search, history.state, options), 'replace');
    const onPopState = (event: PopStateEvent) => void navigate(
      selectionFromLocation(location.pathname + location.search, event.state, options),
      'replace',
    );
    window.addEventListener('popstate', onPopState);
    return () => {
      generation.current += 1;
      window.removeEventListener('popstate', onPopState);
    };
  }, [navigate]);

  const setDraft = useCallback((value: string) => {
    if (!actionOwnerIsReady()) return;
    setDraftState(value);
    writeComposerDraft(draftScope(options, selectionRef.current), value);
  }, [actionOwnerIsReady, options.productId, options.userId]);

  const setAttachmentIds = useCallback((value: SetStateAction<string[]>) => {
    if (!actionOwnerIsReady()) return;
    const next = typeof value === 'function' ? value(attachmentIdsRef.current) : value;
    const owned = [...next];
    const ownerKey = attachmentOwnerKey(options, selectionRef.current);
    if (owned.length === 0) attachmentIdsByOwner.current.delete(ownerKey);
    else attachmentIdsByOwner.current.set(ownerKey, owned);
    attachmentIdsRef.current = owned;
    setAttachmentIdsState(owned);
  }, [actionOwnerIsReady, options.productId, options.userId]);

  const selectVirtualConversation = useCallback((virtualConversationId: string) => {
    if (!actionOwnerIsReady()) return;
    generation.current += 1;
    const next = {
      ...selectionRef.current,
      conversationId: undefined,
      virtualConversationId,
    };
    installSelection(next);
    if (workspace) setPhase('ready');
    if (next.contextId && next.routeId) {
      const target = formatWorkspaceLocation({
        contextId: next.contextId,
        routeId: next.routeId,
        ...(workspace && next.checkpointId !== workspace.headCheckpoint.id
          ? { checkpointId: next.checkpointId }
          : {}),
      });
      if (target !== location.pathname + location.search ||
          virtualConversationFromHistory(history.state, options) !== virtualConversationId) {
        history.pushState(virtualHistoryState(options, virtualConversationId), '', target);
      }
    }
  }, [actionOwnerIsReady, installSelection, options.productId, options.userId, workspace]);

  const startVirtualConversation = useCallback(() => {
    const id = options.createVirtualConversationId?.() ?? `virtual:new:${crypto.randomUUID()}`;
    selectVirtualConversation(id);
  }, [options.createVirtualConversationId, selectVirtualConversation]);

  const selectCheckpoint = useCallback(async (checkpointId: string) => {
    if (!actionOwnerIsReady()) return;
    const current = selectionRef.current;
    if (!current.contextId || !current.routeId) return;
    await navigate({ ...current, checkpointId }, 'push');
  }, [actionOwnerIsReady, navigate]);

  const settleCommand = useCallback(async (result: CommandFinishedPayload) => {
    if (!actionOwnerIsReady() || result.outcome !== 'succeeded') return;
    const previous = selectionRef.current;
    clearComposerDraft(draftScope(options, previous));
    setDraftState('');
    setAttachmentIds([]);
    await navigate({
      contextId: result.contextId ?? previous.contextId,
      routeId: result.routeId ?? previous.routeId,
      conversationId: result.conversationId ?? previous.conversationId,
      checkpointId: result.checkpointId ?? previous.checkpointId,
    }, 'replace');
  }, [actionOwnerIsReady, navigate, options.productId, options.userId, setAttachmentIds]);

  return {
    phase: identityReady ? phase : 'loading' as WorkspacePhase,
    selection: identityReady ? selection : {},
    workspace: identityReady ? workspace : undefined,
    draft: identityReady ? draft : '',
    attachmentIds: identityReady ? attachmentIds : [],
    setDraft,
    setAttachmentIds,
    selectCheckpoint,
    startVirtualConversation,
    selectVirtualConversation,
    settleCommand,
  };
}
