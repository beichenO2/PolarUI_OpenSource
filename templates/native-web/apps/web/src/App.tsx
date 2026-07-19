import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import { ArchivePanel } from './archive/ArchivePanel';
import { downloadUrl, type StagedAttachment } from './assets/api';
import type { SessionUser } from './auth/api';
import {
  ConversationPane,
  type RetainedComposerSnapshot,
} from './commands/ThreadConversation';
import {
  renameContext,
  updateConversation,
  type RouteWorkspace,
  type WorkflowContext,
  type WorkflowConversation,
} from './domain/api';
import { HistoricalMemoryPanel, MemoryPanel } from './memory/MemoryPanel';
import { StageProjectionPanel } from './stages/StageProjectionPanel';
import { ContextSidebar } from './workspace/ContextSidebar';
import { ConversationSwitcher } from './workspace/ConversationSwitcher';
import { ConversationDrawer } from './workspace/ThreadDrawer';
import { VersionArchive } from './workspace/VersionArchive';
import {
  formatWorkspaceLocation,
  parseWorkspaceLocation,
  useWorkflowWorkspace,
  type WorkspaceSelection,
} from './workspace/useWorkflowWorkspace';

export type PublicProductManifest = Omit<ProductManifest, 'workflow' | 'intents' | 'stages'> & {
  workflow: { id: string };
  intents?: ProductManifest['intents'];
  stages?: ProductManifest['stages'];
};

type ContextTitleMetadata = Pick<WorkflowContext, 'title'>;
type ConversationTitleMetadata = Pick<WorkflowConversation, 'title' | 'titleSource'>;
type InspectorTab = 'context-memory' | 'user-memory' | 'artifacts' | 'run';

const inspectorTabs: Array<{ id: InspectorTab; label: string }> = [
  { id: 'context-memory', label: '情景记忆' },
  { id: 'user-memory', label: '用户记忆' },
  { id: 'artifacts', label: '成果' },
  { id: 'run', label: '运行' },
];

function ProductBar({ manifest, user, onLogout, onArchive }: {
  manifest: PublicProductManifest;
  user?: SessionUser;
  onLogout?: () => void;
  onArchive?: () => void;
}) {
  return <header className="product-bar" data-testid="product-bar">
    <div className="product-identity">
      <span className="product-mark" aria-hidden="true">P</span>
      <div>
        <strong>{manifest.product.name}</strong>
        <span className="product-subtitle">Workflow Input</span>
      </div>
    </div>
    <div className="workflow-status">
      <span className="status-dot" aria-hidden="true" />
      <span className="status-label">已同步</span>
      {user && <button className="header-logout" type="button" onClick={onArchive}>导入档案</button>}
      {user && <button className="header-logout" type="button" onClick={onLogout}>{user.username} · 退出</button>}
    </div>
  </header>;
}

function WorkspaceHeader({
  workspace,
  phase,
  contextLayerOpen,
  onOpenContexts,
  onManage,
  onOpenVersions,
  contextLayerButtonRef,
  manageButtonRef,
}: {
  workspace?: RouteWorkspace;
  phase: ReturnType<typeof useWorkflowWorkspace>['phase'];
  contextLayerOpen: boolean;
  onOpenContexts(): void;
  onManage(): void;
  onOpenVersions(): void;
  contextLayerButtonRef: React.RefObject<HTMLButtonElement | null>;
  manageButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return <header className="workspace-heading">
    <div>
      <p className="eyebrow">{workspace ? workspace.route.name : '新的工作情景'}</p>
      <h1>{workspace?.context.title ?? '你现在想处理什么？'}</h1>
      <span>{phase === 'loading'
        ? '正在载入工作空间'
        : phase === 'error'
          ? '工作空间同步需要重试'
          : workspace
            ? `版本 ${String(workspace.selectedCheckpoint.version).padStart(2, '0')}`
            : '首条 Input 会自动建立并命名 Context'}</span>
      {workspace?.route.originCheckpointId && <div className="route-origin" aria-label="Route 来源">
        <span>来源 Checkpoint {workspace.route.originCheckpointId}</span>
        {workspace.route.origin && <span>
          {workspace.route.origin.routeName} · 版本 {String(workspace.route.origin.version).padStart(2, '0')}
        </span>}
      </div>}
    </div>
    <div className="workspace-heading-actions">
      <button
        ref={contextLayerButtonRef}
        className="contexts-mobile-trigger"
        type="button"
        aria-label="打开 Contexts"
        aria-controls="context-mobile-layer"
        aria-expanded={contextLayerOpen}
        onClick={onOpenContexts}
      >Contexts</button>
      {workspace && <button type="button" aria-label="打开版本归档" onClick={onOpenVersions}>版本归档</button>}
      <button ref={manageButtonRef} type="button" onClick={onManage}>管理 Conversations</button>
    </div>
  </header>;
}

function stagedPlaceholders(attachmentIds: string[]): StagedAttachment[] {
  return attachmentIds.map((id, index) => ({
    id,
    filename: `已暂存附件 ${index + 1}`,
    mediaType: 'application/octet-stream',
    byteSize: 0,
    sha256: '',
    status: 'pending',
    conversationId: null,
    createdAt: '',
  }));
}

function pushSelection(selection: WorkspaceSelection) {
  history.pushState({}, '', formatWorkspaceLocation(selection));
}

function pushContext(contextId: string) {
  history.pushState(
    {},
    '',
    `/contexts/${encodeURIComponent(contextId)}/routes/__preferred__`,
  );
}

interface PendingNavigation {
  ownerIdentity: string;
  navigationKind: 'selection' | 'context' | 'settlement';
  selection: WorkspaceSelection;
  draft: string;
  attachmentIds: string[];
  draftDirty: boolean;
  attachmentsDirty: boolean;
  sourceSelection: WorkspaceSelection;
  sourceDraft: string;
  sourceAttachmentIds: string[];
}

function selectionReached(target: WorkspaceSelection, actual: WorkspaceSelection) {
  return (!target.contextId || target.contextId === actual.contextId) &&
    (!target.routeId || target.routeId === actual.routeId) &&
    (!target.conversationId || target.conversationId === actual.conversationId) &&
    (!target.virtualConversationId || target.virtualConversationId === actual.virtualConversationId) &&
    (!target.checkpointId || target.checkpointId === actual.checkpointId);
}

function settlementSnapshotKey(ownerIdentity: string, selection: WorkspaceSelection) {
  return [
    ownerIdentity,
    selection.contextId ?? 'zero-context',
    selection.routeId ?? 'zero-route',
    selection.conversationId ?? selection.virtualConversationId ?? 'zero-conversation',
  ].map(encodeURIComponent).join(':');
}

function settlementMatchesRequestedCheckpoint(
  settlement: PendingNavigation,
  requested: WorkspaceSelection,
) {
  return !requested.checkpointId ||
    requested.checkpointId === settlement.selection.checkpointId;
}

function locationReachedCanonicalSelection(
  requested: WorkspaceSelection,
  actual: WorkspaceSelection,
  workspace?: RouteWorkspace,
) {
  return requested.contextId === actual.contextId &&
    requested.routeId === actual.routeId &&
    requested.conversationId === actual.conversationId &&
    requested.virtualConversationId === actual.virtualConversationId &&
    (!requested.checkpointId || requested.checkpointId === actual.checkpointId) &&
    (Boolean(requested.checkpointId) || !workspace ||
      actual.checkpointId === workspace.headCheckpoint.id);
}

function locationReachedCanonicalRoot(
  phase: ReturnType<typeof useWorkflowWorkspace>['phase'],
  actual: WorkspaceSelection,
  workspace?: RouteWorkspace,
) {
  if (location.pathname + location.search !== '/' || workspace) return false;
  if (phase === 'empty') {
    return !actual.contextId && !actual.routeId && !actual.conversationId &&
      !actual.checkpointId && actual.virtualConversationId === 'virtual:start';
  }
  if (phase === 'initializing' && actual.contextId) {
    return !actual.routeId && !actual.conversationId && !actual.checkpointId &&
      actual.virtualConversationId === `virtual:primary:${actual.contextId}`;
  }
  return false;
}

function currentLocationSelection(productId: string, userId: string): WorkspaceSelection {
  const selection = parseWorkspaceLocation(location.pathname + location.search);
  const value: unknown = history.state;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return selection;
  const state = (value as Record<string, unknown>).polarNativeWorkflow;
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return selection;
  const candidate = state as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.productId !== productId || candidate.userId !== userId ||
      typeof candidate.virtualConversationId !== 'string' ||
      !candidate.virtualConversationId.startsWith('virtual:') || selection.conversationId) {
    return selection;
  }
  return { ...selection, virtualConversationId: candidate.virtualConversationId };
}

export function App({ manifest, user, onLogout }: {
  manifest: PublicProductManifest;
  user?: SessionUser;
  onLogout?: () => void;
}) {
  const workflow = useWorkflowWorkspace({
    productId: manifest.product.id,
    userId: user?.id ?? 'anonymous',
  });
  const ownerIdentity = `${encodeURIComponent(manifest.product.id)}:${encodeURIComponent(user?.id ?? 'anonymous')}`;
  const [showArchive, setShowArchive] = useState(false);
  const [versionArchiveOwner, setVersionArchiveOwner] = useState<{
    ownerIdentity: string;
    routeId: string;
  }>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileContextOwner, setMobileContextOwner] = useState<string>();
  const [inspectorSelection, setInspectorSelection] = useState(() => ({
    ownerIdentity,
    tab: 'context-memory' as InspectorTab,
  }));
  const [mobileInspectorOwner, setMobileInspectorOwner] = useState<string>();
  const [memoryRevision, setMemoryRevision] = useState(0);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation>();
  const [failedNavigation, setFailedNavigation] = useState<PendingNavigation>();
  const [settlementSnapshots, setSettlementSnapshots] = useState(
    () => new Map<string, PendingNavigation>(),
  );
  const [workspaceRetryRevision, setWorkspaceRetryRevision] = useState(0);
  const [archivedConversationKeys, setArchivedConversationKeys] = useState(
    () => new Set<string>(),
  );
  const [bootstrapDrafts, setBootstrapDrafts] = useState(() => new Map<string, string>());
  const [bootstrapAttachmentIdsByOwner, setBootstrapAttachmentIdsByOwner] = useState(
    () => new Map<string, string[]>(),
  );
  const [contextMetadata, setContextMetadata] = useState(
    () => new Map<string, ContextTitleMetadata>(),
  );
  const [conversationMetadata, setConversationMetadata] = useState(
    () => new Map<string, ConversationTitleMetadata>(),
  );
  const inspectorTab = inspectorSelection.ownerIdentity === ownerIdentity
    ? inspectorSelection.tab
    : 'context-memory';
  const mobileContextOpen = mobileContextOwner === ownerIdentity;
  const mobileInspectorOpen = mobileInspectorOwner === ownerIdentity;
  const contextLayerTrigger = useRef<HTMLButtonElement>(null);
  const contextLayerClose = useRef<HTMLButtonElement>(null);
  const inspectorTrigger = useRef<HTMLButtonElement>(null);
  const inspectorClose = useRef<HTMLButtonElement>(null);
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const internalPopState = useRef(false);
  const latestOwnerIdentityRef = useRef(ownerIdentity);
  const activePending = pendingNavigation?.ownerIdentity === ownerIdentity
    ? pendingNavigation
    : undefined;
  const activeFailedNavigation = failedNavigation?.ownerIdentity === ownerIdentity
    ? failedNavigation
    : undefined;
  const activeNavigation = activePending ?? (
    activeFailedNavigation?.navigationKind === 'settlement'
      ? activeFailedNavigation
      : undefined
  );
  const bootstrapDraft = bootstrapDrafts.get(ownerIdentity);
  const bootstrapAttachmentIds = bootstrapAttachmentIdsByOwner.get(ownerIdentity);
  const workspaceScopeResolved = workflow.phase === 'empty' ||
    workflow.phase === 'ready' || workflow.phase === 'initializing';
  const isUnresolvedIdentity = !workspaceScopeResolved &&
    !workflow.selection.contextId &&
    !workflow.selection.routeId &&
    !workflow.selection.virtualConversationId;
  const displaySelection = activeNavigation?.selection ?? workflow.selection;
  const workspaceMatchesNavigation = activeNavigation && workflow.workspace
    ? activeNavigation.selection.contextId === workflow.workspace.context.id &&
      (!activeNavigation.selection.routeId ||
        activeNavigation.selection.routeId === workflow.workspace.route.id)
    : false;
  const baseWorkspace = activeNavigation
    ? workspaceMatchesNavigation ? workflow.workspace : undefined
    : workflow.workspace;
  const workspace = baseWorkspace ? {
    ...baseWorkspace,
    context: {
      ...baseWorkspace.context,
      ...(contextMetadata.get(`${ownerIdentity}:${encodeURIComponent(baseWorkspace.context.id)}`) ?? {}),
    },
    conversations: baseWorkspace.conversations.map((item) => ({
      ...item,
      ...(conversationMetadata.get(`${ownerIdentity}:${encodeURIComponent(item.id)}`) ?? {}),
    })),
  } : undefined;
  const conversations = (workspace?.conversations ?? []).filter((item) =>
    !archivedConversationKeys.has(`${ownerIdentity}:${encodeURIComponent(item.id)}`));
  const activeConversation = conversations.find(({ id }) => id === displaySelection.conversationId);
  const displayCheckpoint = activeNavigation
    ? activeNavigation.selection.checkpointId
      ? workspace?.checkpoints.find(({ id }) => id === activeNavigation.selection.checkpointId)
      : undefined
    : workspace?.selectedCheckpoint;
  const displayIsHistorical = activeNavigation
    ? activeNavigation.navigationKind === 'settlement'
      ? false
      : Boolean(activeNavigation.selection.checkpointId)
    : Boolean(workspace?.isHistorical);
  const displayArtifacts = displayCheckpoint?.snapshot.artifacts ?? [];
  const displayStageProjection = displayCheckpoint?.snapshot.stageProjection;
  const displayDraft = activeNavigation?.draft ?? bootstrapDraft ?? workflow.draft;
  const displayAttachmentIds = activeNavigation?.attachmentIds ??
    bootstrapAttachmentIds ?? workflow.attachmentIds;
  const scopeReady = !activeNavigation && bootstrapDraft === undefined &&
    bootstrapAttachmentIds === undefined && workspaceScopeResolved;
  const routeName = workspace?.route.name ?? '等待 Workflow 建立 Route';
  const versionArchiveOpen = Boolean(workspace &&
    versionArchiveOwner?.ownerIdentity === ownerIdentity &&
    versionArchiveOwner.routeId === workspace.route.id);
  const latestArchiveState = useRef({
    ownerIdentity,
    selection: displaySelection,
    workspace,
    conversations,
  });
  const latestView = useRef({
    ownerIdentity,
    selection: displaySelection,
    draft: displayDraft,
    attachmentIds: displayAttachmentIds,
  });

  useLayoutEffect(() => {
    latestOwnerIdentityRef.current = ownerIdentity;
    latestArchiveState.current = {
      ownerIdentity,
      selection: displaySelection,
      workspace,
      conversations,
    };
    latestView.current = {
      ownerIdentity,
      selection: displaySelection,
      draft: displayDraft,
      attachmentIds: displayAttachmentIds,
    };
  });

  useEffect(() => {
    if (bootstrapDraft === undefined || !workspaceScopeResolved) return;
    if (workflow.draft !== bootstrapDraft) {
      workflow.setDraft(bootstrapDraft);
      return;
    }
    setBootstrapDrafts((current) => {
      if (current.get(ownerIdentity) !== bootstrapDraft) return current;
      const next = new Map(current);
      next.delete(ownerIdentity);
      return next;
    });
  }, [bootstrapDraft, ownerIdentity, workflow.draft, workflow.setDraft, workspaceScopeResolved]);

  useEffect(() => {
    if (bootstrapAttachmentIds === undefined || !workspaceScopeResolved) return;
    if (workflow.attachmentIds.join(',') !== bootstrapAttachmentIds.join(',')) {
      workflow.setAttachmentIds(bootstrapAttachmentIds);
      return;
    }
    setBootstrapAttachmentIdsByOwner((current) => {
      if (current.get(ownerIdentity) !== bootstrapAttachmentIds) return current;
      const next = new Map(current);
      next.delete(ownerIdentity);
      return next;
    });
  }, [
    bootstrapAttachmentIds,
    ownerIdentity,
    workflow.attachmentIds,
    workflow.setAttachmentIds,
    workspaceScopeResolved,
  ]);

  useEffect(() => {
    if (!activePending || !workspaceScopeResolved) return;
    const reachedStrictly = selectionReached(activePending.selection, workflow.selection);
    const requestedLocation = currentLocationSelection(
      manifest.product.id,
      user?.id ?? 'anonymous',
    );
    const reachedCanonicalFallback = activePending.navigationKind !== 'settlement' &&
      (locationReachedCanonicalSelection(requestedLocation, workflow.selection, workflow.workspace) ||
        locationReachedCanonicalRoot(workflow.phase, workflow.selection, workflow.workspace));
    if (!reachedStrictly && !reachedCanonicalFallback) return;
    if (activePending.draftDirty) workflow.setDraft(activePending.draft);
    if (activePending.attachmentsDirty) workflow.setAttachmentIds(activePending.attachmentIds);
    if (activePending.navigationKind === 'settlement') {
      const key = settlementSnapshotKey(activePending.ownerIdentity, activePending.selection);
      setSettlementSnapshots((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }
    setPendingNavigation((current) => current === activePending ? undefined : current);
  }, [
    activePending,
    manifest.product.id,
    user?.id,
    workflow.selection,
    workflow.phase,
    workflow.setDraft,
    workflow.setAttachmentIds,
    workflow.workspace,
    workspaceScopeResolved,
  ]);

  useEffect(() => {
    if (!activePending || workflow.phase !== 'error') return;
    setFailedNavigation(activePending);
    setPendingNavigation((current) => current === activePending ? undefined : current);
  }, [activePending, workflow.phase]);

  useEffect(() => {
    setPendingNavigation(undefined);
    setFailedNavigation(undefined);
    setVersionArchiveOwner(undefined);
  }, [ownerIdentity]);

  useEffect(() => {
    if (mobileContextOpen) contextLayerClose.current?.focus();
  }, [mobileContextOpen]);

  useEffect(() => {
    if (mobileInspectorOpen) inspectorClose.current?.focus();
  }, [mobileInspectorOpen]);

  useEffect(() => {
    if (!versionArchiveOwner || !workspace ||
        versionArchiveOwner.ownerIdentity !== ownerIdentity ||
        versionArchiveOwner.routeId === workspace.route.id) return;
    setVersionArchiveOwner(undefined);
  }, [ownerIdentity, versionArchiveOwner, workspace]);

  useEffect(() => {
    const onPopState = () => {
      if (internalPopState.current) {
        internalPopState.current = false;
        return;
      }
      const requested = currentLocationSelection(
        manifest.product.id,
        user?.id ?? 'anonymous',
      );
      const requestedKey = settlementSnapshotKey(ownerIdentity, requested);
      const restored = settlementSnapshots.get(requestedKey);
      if (restored && settlementMatchesRequestedCheckpoint(restored, requested)) {
        setPendingNavigation(restored);
        setFailedNavigation((current) => (
          current?.ownerIdentity === ownerIdentity && current.navigationKind === 'settlement'
            ? undefined
            : current
        ));
        return;
      }
      const source = latestView.current;
      setFailedNavigation(undefined);
      setPendingNavigation({
        ownerIdentity,
        navigationKind: 'selection',
        selection: requested,
        draft: '',
        attachmentIds: [],
        draftDirty: false,
        attachmentsDirty: false,
        sourceSelection: source.selection,
        sourceDraft: source.draft,
        sourceAttachmentIds: [...source.attachmentIds],
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [manifest.product.id, ownerIdentity, settlementSnapshots, user?.id]);

  const dispatchInternalPopState = () => {
    internalPopState.current = true;
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  };

  const dispatchNavigation = (navigation: Pick<PendingNavigation, 'navigationKind' | 'selection'>) => {
    const { selection } = navigation;
    if (navigation.navigationKind === 'context' && selection.contextId) {
      pushContext(selection.contextId);
    } else if (selection.virtualConversationId) {
      history.pushState({
        polarNativeWorkflow: {
          version: 1,
          productId: manifest.product.id,
          userId: user?.id ?? 'anonymous',
          virtualConversationId: selection.virtualConversationId,
        },
      }, '', formatWorkspaceLocation(selection));
    } else {
      pushSelection(selection);
    }
    dispatchInternalPopState();
  };

  const beginNavigation = (
    selection: WorkspaceSelection,
    options: {
      preserveDraft?: boolean;
      preserveAttachments?: boolean;
      navigationKind?: PendingNavigation['navigationKind'];
    } = {},
  ) => {
    const navigation: PendingNavigation = {
      ownerIdentity,
      navigationKind: options.navigationKind ?? 'selection',
      selection,
      draft: options.preserveDraft ? displayDraft : '',
      attachmentIds: options.preserveAttachments ? displayAttachmentIds : [],
      draftDirty: Boolean(options.preserveDraft),
      attachmentsDirty: Boolean(options.preserveAttachments),
      sourceSelection: displaySelection,
      sourceDraft: displayDraft,
      sourceAttachmentIds: [...displayAttachmentIds],
    };
    setFailedNavigation(undefined);
    setPendingNavigation(navigation);
    dispatchNavigation(navigation);
  };

  const selectConversation = (conversationId: string) => {
    if (!workspace) return;
    beginNavigation({
      contextId: workspace.context.id,
      routeId: workspace.route.id,
      conversationId,
      ...(workspace.isHistorical ? { checkpointId: workspace.selectedCheckpoint.id } : {}),
    });
  };

  const renameConversation = async (conversationId: string, title: string) => {
    const updated = await updateConversation(conversationId, { title });
    setConversationMetadata((current) => {
      const next = new Map(current);
      next.set(`${ownerIdentity}:${encodeURIComponent(updated.id)}`, {
        title: updated.title,
        titleSource: updated.titleSource,
      });
      return next;
    });
  };

  const archiveConversation = async (conversationId: string) => {
    const requestedOwner = ownerIdentity;
    await updateConversation(conversationId, { status: 'archived' });
    setArchivedConversationKeys((current) => {
      const next = new Set(current);
      next.add(`${requestedOwner}:${encodeURIComponent(conversationId)}`);
      return next;
    });

    const latest = latestArchiveState.current;
    const selectionIsCurrent = latest.ownerIdentity === requestedOwner &&
      latest.selection.conversationId === conversationId;
    if (!selectionIsCurrent || !latest.workspace) return;

    const replacement = latest.conversations.find((item) =>
      item.id !== conversationId && item.status === 'active');
    beginNavigation({
      contextId: latest.workspace.context.id,
      routeId: latest.workspace.route.id,
      ...(replacement ? { conversationId: replacement.id } : {}),
      ...(latest.workspace.isHistorical
        ? { checkpointId: latest.workspace.selectedCheckpoint.id }
        : {}),
    });
  };

  const switcherProps = {
    conversations,
    selectedConversationId: displaySelection.conversationId,
    virtualConversationId: displaySelection.virtualConversationId,
    routeName,
    onSelectConversation: selectConversation,
    onNewConversation: workflow.startVirtualConversation,
    onRenameConversation: renameConversation,
    onArchiveConversation: archiveConversation,
  };

  const retryFailedNavigation = () => {
    if (!activeFailedNavigation) return;
    setFailedNavigation(undefined);
    setPendingNavigation(activeFailedNavigation);
    dispatchNavigation(activeFailedNavigation);
  };

  const returnToFailedNavigationSource = () => {
    if (!activeFailedNavigation) return;
    const source = activeFailedNavigation.sourceSelection;
    if (activeFailedNavigation.navigationKind === 'settlement') {
      const handoff: PendingNavigation = {
        ...activeFailedNavigation,
        navigationKind: 'settlement',
        selection: source,
        draft: activeFailedNavigation.draft,
        attachmentIds: [...activeFailedNavigation.attachmentIds],
        draftDirty: true,
        attachmentsDirty: true,
        sourceSelection: source,
        sourceDraft: activeFailedNavigation.draft,
        sourceAttachmentIds: [...activeFailedNavigation.attachmentIds],
      };
      setSettlementSnapshots((current) => {
        const next = new Map(current);
        next.delete(settlementSnapshotKey(
          activeFailedNavigation.ownerIdentity,
          activeFailedNavigation.selection,
        ));
        next.set(settlementSnapshotKey(handoff.ownerIdentity, handoff.selection), handoff);
        return next;
      });
      setFailedNavigation(undefined);
      setPendingNavigation(handoff);
      dispatchNavigation(handoff);
      return;
    }
    setFailedNavigation(undefined);
    dispatchNavigation({ navigationKind: 'selection', selection: source });
  };

  const updateActiveNavigation = (
    updates: Partial<Pick<
      PendingNavigation,
      'draft' | 'attachmentIds' | 'draftDirty' | 'attachmentsDirty'
    >>,
  ) => {
    if (!activeNavigation) return false;
    const next: PendingNavigation = { ...activeNavigation, ...updates };
    if (activePending === activeNavigation) {
      setPendingNavigation((current) => current === activeNavigation ? next : current);
    } else {
      setFailedNavigation((current) => current === activeNavigation ? next : current);
    }
    if (next.navigationKind === 'settlement') {
      setSettlementSnapshots((current) => {
        const updated = new Map(current);
        updated.set(settlementSnapshotKey(next.ownerIdentity, next.selection), next);
        return updated;
      });
    }
    return true;
  };

  const retryWorkspace = () => {
    setWorkspaceRetryRevision((current) => current + 1);
    dispatchInternalPopState();
  };

  const focusWorkflowInput = () => {
    const focus = () => document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Workflow Input"]',
    )?.focus();
    focus();
    requestAnimationFrame(focus);
  };

  const closeMobileContexts = () => {
    setMobileContextOwner(undefined);
    queueMicrotask(() => contextLayerTrigger.current?.focus());
  };

  const closeMobileInspector = () => {
    setMobileInspectorOwner(undefined);
    queueMicrotask(() => inspectorTrigger.current?.focus());
  };

  const selectArchivedCheckpoint = (checkpointId: string) => {
    if (!workspace || !workspace.checkpoints.some(({ id }) => id === checkpointId)) return;
    beginNavigation({
      contextId: workspace.context.id,
      routeId: workspace.route.id,
      ...(displaySelection.conversationId
        ? { conversationId: displaySelection.conversationId }
        : displaySelection.virtualConversationId
          ? { virtualConversationId: displaySelection.virtualConversationId }
          : {}),
      ...(checkpointId === workspace.headCheckpoint.id ? {} : { checkpointId }),
    }, { preserveDraft: true, preserveAttachments: true });
    focusWorkflowInput();
  };

  return <div className="app-shell conversation-first-shell">
    <ProductBar
      manifest={manifest}
      user={user}
      onLogout={onLogout}
      onArchive={() => setShowArchive(true)}
    />
    {showArchive && <ArchivePanel key={`archive:${ownerIdentity}`} onClose={() => setShowArchive(false)} />}
    {versionArchiveOpen && workspace && <VersionArchive
      key={`versions:${ownerIdentity}:${workspace.route.id}`}
      checkpoints={workspace.checkpoints}
      routeName={workspace.route.name}
      headCheckpointId={workspace.headCheckpoint.id}
      initialCheckpointId={displayCheckpoint?.id ?? workspace.selectedCheckpoint.id}
      onClose={() => setVersionArchiveOwner(undefined)}
      onSelectCheckpoint={selectArchivedCheckpoint}
    />}

    <div
      id="context-mobile-layer"
      className="context-sidebar-layer"
      data-mobile-open={mobileContextOpen}
      role={mobileContextOpen ? 'dialog' : undefined}
      aria-label={mobileContextOpen ? 'Contexts' : undefined}
      aria-modal={mobileContextOpen ? 'true' : undefined}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        closeMobileContexts();
      }}
    >
      {mobileContextOpen && <header className="context-mobile-layer-header">
        <div><p className="eyebrow">Context</p><h2>Contexts</h2></div>
        <button ref={contextLayerClose} type="button" aria-label="关闭 Contexts" onClick={closeMobileContexts}>
          关闭
        </button>
      </header>}
      <ContextSidebar
        key={`contexts:${ownerIdentity}:${workspaceRetryRevision}`}
        selectedContextId={displaySelection.contextId}
        onSelectContext={(contextId) => {
          if (latestOwnerIdentityRef.current !== ownerIdentity) return;
          setMobileContextOwner(undefined);
          beginNavigation({ contextId }, { navigationKind: 'context' });
        }}
        onRenameContext={async (contextId, title) => {
          const updated = await renameContext(contextId, { title });
          setContextMetadata((current) => {
            const next = new Map(current);
            next.set(`${ownerIdentity}:${encodeURIComponent(updated.id)}`, { title: updated.title });
            return next;
          });
        }}
        onImport={() => setShowArchive(true)}
      />
    </div>

    <main className="conversation-axis" data-testid="workspace-slot" aria-busy={workflow.phase === 'loading'}>
      <WorkspaceHeader
        workspace={workspace}
        phase={workflow.phase}
        contextLayerOpen={mobileContextOpen}
        contextLayerButtonRef={contextLayerTrigger}
        onOpenContexts={() => setMobileContextOwner(ownerIdentity)}
        manageButtonRef={drawerTrigger}
        onManage={() => setDrawerOpen(true)}
        onOpenVersions={() => {
          if (!workspace) return;
          setVersionArchiveOwner({ ownerIdentity, routeId: workspace.route.id });
        }}
      />
      <button
        ref={inspectorTrigger}
        className="inspector-mobile-trigger"
        type="button"
        aria-label="打开记忆、成果与运行检查器"
        aria-controls="workspace-inspector"
        aria-expanded={mobileInspectorOpen}
        onClick={() => setMobileInspectorOwner(ownerIdentity)}
      >记忆、成果与运行</button>
      {workflow.phase === 'error' && <div className="domain-error" role="alert">
        <p>工作空间暂时无法同步。Input 与附件仍保留在当前 Conversation。</p>
        {activeFailedNavigation ? <div>
          <button type="button" onClick={retryFailedNavigation}>重试打开目标</button>
          <button type="button" onClick={returnToFailedNavigationSource}>返回原 Conversation</button>
        </div> : <button type="button" onClick={retryWorkspace}>重试同步</button>}
      </div>}
      <ConversationSwitcher key={`switcher:${ownerIdentity}:main`} {...switcherProps} />
      <ConversationPane
        ownerIdentity={ownerIdentity}
        selection={displaySelection}
        conversation={activeConversation}
        checkpoint={displayCheckpoint}
        intents={manifest.intents ?? []}
        stagedAttachments={stagedPlaceholders(displayAttachmentIds)}
        draft={displayDraft}
        onDraftChange={(value) => {
          if (updateActiveNavigation({ draft: value, draftDirty: true })) return;
          if (bootstrapDraft !== undefined || isUnresolvedIdentity) {
            setBootstrapDrafts((current) => {
              const next = new Map(current);
              next.set(ownerIdentity, value);
              return next;
            });
          } else {
            workflow.setDraft(value);
          }
        }}
        onAttachmentIdsChange={(attachmentIds) => {
          if (updateActiveNavigation({
            attachmentIds: [...attachmentIds],
            attachmentsDirty: true,
          })) return;
          if (bootstrapAttachmentIds !== undefined || isUnresolvedIdentity) {
            setBootstrapAttachmentIdsByOwner((current) => {
              const next = new Map(current);
              next.set(ownerIdentity, [...attachmentIds]);
              return next;
            });
          } else {
            workflow.setAttachmentIds(attachmentIds);
          }
        }}
        scopeReady={scopeReady}
        isHistorical={displayIsHistorical}
        onCommandFinished={(result, retained: RetainedComposerSnapshot = {
          draft: '',
          attachmentIds: [],
        }) => {
          setMemoryRevision((current) => current + 1);
          const target: WorkspaceSelection = {
            contextId: result.contextId ?? displaySelection.contextId,
            routeId: result.routeId ?? displaySelection.routeId,
            conversationId: result.conversationId ?? displaySelection.conversationId,
            checkpointId: result.checkpointId ?? displaySelection.checkpointId,
          };
          const settlement: PendingNavigation = {
            ownerIdentity,
            navigationKind: 'settlement',
            selection: target,
            draft: retained.draft,
            attachmentIds: [...retained.attachmentIds],
            draftDirty: true,
            attachmentsDirty: true,
            sourceSelection: displaySelection,
            sourceDraft: displayDraft,
            sourceAttachmentIds: [...displayAttachmentIds],
          };
          setSettlementSnapshots((current) => {
            const next = new Map(current);
            next.set(settlementSnapshotKey(settlement.ownerIdentity, settlement.selection), settlement);
            return next;
          });
          setFailedNavigation(undefined);
          setPendingNavigation(settlement);
          void workflow.settleCommand(result);
        }}
        onConflict={() => {
          const conflictWorkspace = workspace ?? workflow.workspace;
          if (!conflictWorkspace) {
            dispatchInternalPopState();
            return;
          }
          beginNavigation({
            contextId: conflictWorkspace.context.id,
            routeId: conflictWorkspace.route.id,
            ...(displaySelection.conversationId
              ? { conversationId: displaySelection.conversationId }
              : displaySelection.virtualConversationId
                ? { virtualConversationId: displaySelection.virtualConversationId }
                : {}),
          }, { preserveDraft: true, preserveAttachments: true });
        }}
      />
    </main>

    <aside
      id="workspace-inspector"
      className="workspace-inspector"
      role={mobileInspectorOpen ? 'dialog' : undefined}
      aria-label="工作空间检查器"
      aria-modal={mobileInspectorOpen ? 'true' : undefined}
      data-mobile-open={mobileInspectorOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        closeMobileInspector();
      }}
    >
      <header className="workspace-inspector-header">
        <div><p className="eyebrow">Inspector</p><h2>Context 状态</h2></div>
        <button
          ref={inspectorClose}
          type="button"
          aria-label="关闭记忆、成果与运行检查器"
          onClick={closeMobileInspector}
        >关闭</button>
      </header>
      <div role="tablist" aria-label="工作空间检查器视图">
        {inspectorTabs.map((tab) => <button
          key={tab.id}
          id={`inspector-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={inspectorTab === tab.id}
          aria-controls={`inspector-panel-${tab.id}`}
          onClick={() => setInspectorSelection({ ownerIdentity, tab: tab.id })}
        >{tab.label}</button>)}
      </div>
      <section
        id={`inspector-panel-${inspectorTab}`}
        role="tabpanel"
        aria-labelledby={`inspector-tab-${inspectorTab}`}
      >
        {(inspectorTab === 'context-memory' || inspectorTab === 'user-memory') &&
          (displayIsHistorical && displayCheckpoint ? <HistoricalMemoryPanel
            key={`historical-memory:${ownerIdentity}:${inspectorTab}:${displaySelection.contextId ?? 'zero-context'}:${displayCheckpoint.id}`}
            ownerKey={ownerIdentity}
            contextId={displaySelection.contextId}
            checkpointId={displayCheckpoint.id}
            memoryReferences={displayCheckpoint.snapshot.memoryReferences}
            scope={inspectorTab === 'context-memory' ? 'context' : 'user'}
          /> : <MemoryPanel
            key={`memory:${ownerIdentity}:${inspectorTab}:${inspectorTab === 'context-memory'
              ? displaySelection.contextId ?? 'zero-context'
              : 'cross-context'}`}
            ownerKey={ownerIdentity}
            contextId={displaySelection.contextId}
            scope={inspectorTab === 'context-memory' ? 'context' : 'user'}
            hideScopeTabs
            revision={memoryRevision}
          />)}
        {inspectorTab === 'artifacts' && <section className="inspector-artifacts" aria-label="成果摘要">
          <header><h3>成果</h3><span>{displayArtifacts.length} 个成果</span></header>
          {displayArtifacts.map((artifact) => <article key={`artifact:${artifact.id}`}>
            <a className="download-target" href={downloadUrl({
              kind: 'artifact',
              id: artifact.id,
              filename: artifact.filename,
              mediaType: artifact.media_type,
              byteSize: artifact.byte_size,
              sha256: artifact.sha256,
              createdAt: artifact.created_at,
            })}>
              <strong>{artifact.filename}</strong>
              <span>{artifact.media_type} · {artifact.byte_size} B</span>
            </a>
          </article>)}
          {displayArtifacts.length === 0 && <p>当前版本还没有成果。</p>}
        </section>}
        {inspectorTab === 'run' && <section className="inspector-run" aria-label="运行详情">
          <header><h3>运行</h3><span>{workspace
            ? `${workspace.checkpoints.length} 个版本`
            : '等待 Workflow'}</span></header>
          {displayStageProjection?.items.length
            ? <StageProjectionPanel
              projection={displayStageProjection}
              onSelectCheckpoint={(checkpointId) => {
                if (!workspace) return;
                beginNavigation({
                  contextId: workspace.context.id,
                  routeId: workspace.route.id,
                  ...(displaySelection.conversationId
                    ? { conversationId: displaySelection.conversationId }
                    : displaySelection.virtualConversationId
                      ? { virtualConversationId: displaySelection.virtualConversationId }
                      : {}),
                  checkpointId,
                }, { preserveDraft: true, preserveAttachments: true });
              }}
            />
            : <p>当前没有 Stage Projection。</p>}
        </section>}
      </section>
    </aside>

    {drawerOpen && <ConversationDrawer
      key={`drawer:${ownerIdentity}`}
      {...switcherProps}
      returnFocusRef={drawerTrigger}
      onClose={() => setDrawerOpen(false)}
    />}
  </div>;
}
