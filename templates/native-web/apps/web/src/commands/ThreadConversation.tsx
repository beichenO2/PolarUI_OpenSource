import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import { readComposerDraft, writeComposerDraft, type ComposerDraftScope } from '../auth/storage';
import {
  AttachmentPanel,
  type StagedAttachmentUpdater,
} from '../assets/AttachmentPanel';
import { downloadUrl, type StagedAttachment } from '../assets/api';
import type {
  StageProjection,
  WorkflowCheckpoint,
  WorkflowConversation,
  WorkflowThread,
} from '../domain/api';
import type { WorkspaceSelection } from '../workspace/useWorkflowWorkspace';
import {
  CommandApiError,
  createWorkflowCommand,
  listConversationMessages,
  streamCommandEvents,
  type CommandFinishedPayload,
  type PublicCommandInput,
  type PublicWorkflowInterrupt,
  type WorkflowMessage,
} from './api';

export type NamedIntent = ProductManifest['intents'][number];

function newCommandId() {
  return globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const value = Math.floor(Math.random() * 16);
      return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
    });
}

function errorLabel(code: string) {
  const labels: Record<string, string> = {
    WORKFLOW_TIMEOUT: '处理超时，请重新发送。',
    WORKFLOW_UNAVAILABLE: '服务暂时不可用，请稍后重新发送。',
    CHECKPOINT_VERSION_CONFLICT: '路线已发生变化。请刷新到最新路线头后重试。',
    COMMAND_IN_PROGRESS: '这条命令仍在执行，请稍候。',
  };
  return labels[code] ? `${labels[code]}（${code}）` : code;
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

interface RetainedAttempt {
  input: PublicCommandInput['input'];
  attachmentIds: string[];
}

interface MessageLoadError {
  ownerKey: string;
  message: string;
}

interface AttachmentOwnerSession {
  scope: string;
  owner: string;
  bootstrapCandidate: boolean;
  handoffScope?: string;
}

export interface ConversationPaneProps {
  ownerIdentity: string;
  selection: WorkspaceSelection;
  conversation?: WorkflowConversation;
  checkpoint?: WorkflowCheckpoint;
  intents: NamedIntent[];
  stagedAttachments: StagedAttachment[];
  draft?: string;
  onDraftChange?(value: string): void;
  onAttachmentIdsChange?(attachmentIds: string[]): void;
  scopeReady?: boolean;
  isHistorical?: boolean;
  onCommandFinished(result: CommandFinishedPayload, retained?: RetainedComposerSnapshot): void;
  onConflict?(): void;
}

export interface RetainedComposerSnapshot {
  draft: string;
  attachmentIds: string[];
}

export function ConversationPane({
  ownerIdentity,
  selection,
  conversation,
  checkpoint,
  intents,
  stagedAttachments,
  draft: controlledDraft,
  onDraftChange,
  onAttachmentIdsChange,
  scopeReady = true,
  isHistorical = false,
  onCommandFinished,
  onConflict,
}: ConversationPaneProps) {
  const draftOwnerKey = [
    ownerIdentity,
    selection.contextId ?? 'zero-context',
    selection.routeId ?? 'zero-route',
    selection.conversationId ?? selection.virtualConversationId ?? 'zero-conversation',
  ].map(encodeURIComponent).join(':');
  const interactionOwnerKey = [
    ownerIdentity,
    selection.contextId ?? 'zero-context',
    selection.routeId ?? 'zero-route',
    selection.conversationId ?? selection.virtualConversationId ?? 'zero-conversation',
    selection.checkpointId ?? checkpoint?.id ?? 'zero-checkpoint',
  ].map(encodeURIComponent).join(':');
  const logicalOwnerKey = [
    ownerIdentity,
    selection.contextId ?? 'zero-context',
    selection.routeId ?? 'zero-route',
    selection.conversationId ?? selection.virtualConversationId ?? 'zero-conversation',
  ].map(encodeURIComponent).join(':');
  const attachmentConversationId = conversation?.id ?? selection.conversationId;
  const attachmentOwnerScope = `${encodeURIComponent(ownerIdentity)}:${attachmentConversationId
    ? `conversation:${attachmentConversationId}`
    : `draft:${draftOwnerKey}`}`;
  const isBootstrapAttachmentOwner = !scopeReady && !selection.contextId && !selection.routeId &&
    !selection.conversationId && !selection.virtualConversationId;
  const attachmentSession = useMemo<AttachmentOwnerSession>(() => ({
    scope: attachmentOwnerScope,
    owner: ownerIdentity,
    bootstrapCandidate: isBootstrapAttachmentOwner,
  }), [attachmentOwnerScope, isBootstrapAttachmentOwner, ownerIdentity]);
  const committedAttachmentSession = useRef<AttachmentOwnerSession>();
  const attachmentStorageScope = attachmentSession.handoffScope ?? attachmentSession.scope;
  const [localDraft, setLocalDraft] = useState('');
  const draft = controlledDraft ?? localDraft;
  const changeDraft = onDraftChange ?? setLocalDraft;
  const [messages, setMessages] = useState<WorkflowMessage[]>([]);
  const [pendingInterrupt, setPendingInterrupt] = useState<PublicWorkflowInterrupt | null>(null);
  const [messageOwnerKey, setMessageOwnerKey] = useState(interactionOwnerKey);
  const [messageLoadError, setMessageLoadError] = useState<MessageLoadError>({
    ownerKey: interactionOwnerKey,
    message: '',
  });
  const [interruptDrafts, setInterruptDrafts] = useState(() => new Map<string, string>());
  const [streamedReply, setStreamedReply] = useState('');
  const [streamOwnerKey, setStreamOwnerKey] = useState(interactionOwnerKey);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [liveStatus, setLiveStatus] = useState('等待输入');
  const [error, setError] = useState('');
  const [failedAttempt, setFailedAttempt] = useState<RetainedAttempt>();
  const operation = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const failureOwner = useRef<string | undefined>(undefined);
  const previousScopeReady = useRef(scopeReady);

  const interruptDraft = interruptDrafts.get(logicalOwnerKey) ?? '';
  const changeInterruptDraft = useCallback((value: string) => {
    setInterruptDrafts((current) => {
      const next = new Map(current);
      if (value) next.set(logicalOwnerKey, value);
      else next.delete(logicalOwnerKey);
      return next;
    });
  }, [logicalOwnerKey]);
  const [stagedByOwner, setStagedByOwner] = useState(
    () => scopeReady || stagedAttachments.length > 0
      ? new Map<string, StagedAttachment[]>([[attachmentOwnerScope, stagedAttachments]])
      : new Map<string, StagedAttachment[]>(),
  );
  const stagedKey = stagedAttachments.map(({ id }) => id).join(',');

  useLayoutEffect(() => {
    const previous = committedAttachmentSession.current;
    committedAttachmentSession.current = attachmentSession;
    if (!previous || previous === attachmentSession || !previous.bootstrapCandidate ||
        previous.owner !== attachmentSession.owner) return;
    previous.handoffScope = attachmentSession.scope;
    setStagedByOwner((current) => {
      const source = current.get(previous.scope) ?? [];
      if (source.length === 0) return current;
      const target = current.get(attachmentSession.scope) ?? [];
      const targetIds = new Set(target.map(({ id }) => id));
      const merged = [...target, ...source.filter(({ id }) => !targetIds.has(id))];
      const next = new Map(current);
      next.delete(previous.scope);
      next.set(attachmentSession.scope, merged);
      return next;
    });
  }, [attachmentSession]);

  useEffect(() => {
    setStagedByOwner((current) => {
      if (current.has(attachmentStorageScope)) return current;
      if (!scopeReady && stagedAttachments.length === 0) return current;
      const next = new Map(current);
      next.set(attachmentStorageScope, stagedAttachments);
      return next;
    });
  }, [attachmentStorageScope, scopeReady, stagedKey, stagedAttachments]);

  const currentStaged = stagedByOwner.get(attachmentStorageScope) ?? stagedAttachments;
  const latestDraft = useRef({ ownerKey: logicalOwnerKey, value: draft, change: changeDraft });
  const latestInteraction = useRef({ ownerKey: interactionOwnerKey, scopeReady });
  const latestStaged = useRef({
    session: attachmentSession,
    ownerScope: attachmentStorageScope,
    staged: currentStaged,
    onAttachmentIdsChange,
  });

  useLayoutEffect(() => {
    latestDraft.current = { ownerKey: logicalOwnerKey, value: draft, change: changeDraft };
    latestInteraction.current = { ownerKey: interactionOwnerKey, scopeReady };
    latestStaged.current = {
      session: attachmentSession,
      ownerScope: attachmentStorageScope,
      staged: currentStaged,
      onAttachmentIdsChange,
    };
  });

  useEffect(() => {
    const localIds = currentStaged.map(({ id }) => id);
    if (localIds.join(',') !== stagedKey) onAttachmentIdsChange?.(localIds);
  }, [attachmentStorageScope, currentStaged, onAttachmentIdsChange, stagedKey]);

  const changeStaged = useCallback((session: AttachmentOwnerSession, update: StagedAttachmentUpdater) => {
    const resolvedOwnerScope = session.handoffScope ?? session.scope;
    setStagedByOwner((current) => {
      const previous = current.get(resolvedOwnerScope) ?? [];
      const updated = update(previous);
      if (updated === previous) return current;
      const next = new Map(current);
      next.set(resolvedOwnerScope, updated);
      return next;
    });
  }, []);
  const changeCurrentOwnerStaged = useCallback((_ownerScope: string, update: StagedAttachmentUpdater) => {
    changeStaged(attachmentSession, update);
  }, [attachmentSession, changeStaged]);

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!conversation) {
      setMessages([]);
      setPendingInterrupt(null);
      setMessageOwnerKey(interactionOwnerKey);
      setMessageLoadError({ ownerKey: interactionOwnerKey, message: '' });
      return;
    }
    const state = await listConversationMessages(conversation.id, { signal });
    if (signal?.aborted) return;
    setMessages(state.messages);
    setPendingInterrupt(state.pendingInterrupt);
    setMessageOwnerKey(interactionOwnerKey);
    setMessageLoadError({ ownerKey: interactionOwnerKey, message: '' });
  }, [conversation?.id, interactionOwnerKey]);

  useEffect(() => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    submitting.current = false;
    setBusy(false);
    if (failureOwner.current !== logicalOwnerKey) {
      setError('');
      setFailedAttempt(undefined);
    }
    failureOwner.current = logicalOwnerKey;
    setStreamedReply('');
    setMessageLoadError({ ownerKey: interactionOwnerKey, message: '' });
    if (!scopeReady) {
      setMessages([]);
      setPendingInterrupt(null);
      setMessageOwnerKey(interactionOwnerKey);
      setLoading(false);
      setLiveStatus('正在载入工作空间');
      return () => controller.abort();
    }
    if (!conversation) {
      setMessages([]);
      setPendingInterrupt(null);
      setLoading(false);
      setLiveStatus('等待首条 Input');
      return () => controller.abort();
    }
    setLoading(true);
    setLiveStatus('正在载入 Conversation');
    void reload(controller.signal)
      .then(() => { if (!controller.signal.aborted) setLiveStatus('已保存'); })
      .catch((loadError) => {
        if (!controller.signal.aborted && !isAbort(loadError)) {
          setMessageLoadError({ ownerKey: interactionOwnerKey, message: '消息暂时无法载入。' });
          setLiveStatus('消息同步需要重试');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [interactionOwnerKey, logicalOwnerKey, reload, scopeReady]);

  useEffect(() => () => {
    operation.current?.abort();
    operation.current = null;
  }, []);

  useEffect(() => {
    const wasReady = previousScopeReady.current;
    previousScopeReady.current = scopeReady;
    if (!wasReady || scopeReady) return;
    const controller = operation.current;
    controller?.abort();
    if (operation.current === controller) operation.current = null;
    submitting.current = false;
    setBusy(false);
    setLoading(false);
    setStreamedReply('');
  }, [scopeReady]);

  const runAttempt = useCallback(async (attempt: RetainedAttempt) => {
    if (!scopeReady || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    setFailedAttempt(undefined);
    setStreamedReply('');
    setStreamOwnerKey(interactionOwnerKey);
    const controller = new AbortController();
    operation.current?.abort();
    setLoading(false);
    operation.current = controller;
    const commandId = newCommandId();
    const initializing = !selection.contextId;
    setLiveStatus(initializing ? '正在理解并建立工作情景' : '已接收');

    try {
      const receipt = await createWorkflowCommand({
        commandId,
        contextId: selection.contextId,
        routeId: selection.routeId,
        conversationId: selection.conversationId,
        baseCheckpointId: checkpoint?.id,
        expectedCheckpointVersion: checkpoint?.version,
        input: attempt.input,
        attachmentIds: [...attempt.attachmentIds],
      }, { signal: controller.signal });
      let afterEventId = 0;
      let finished: CommandFinishedPayload | null = null;
      for (let reconnect = 0; reconnect < 3 && !finished; reconnect += 1) {
        try {
          const result = await streamCommandEvents(receipt.eventUrl, {
            afterEventId,
            signal: controller.signal,
          }, (event) => {
            if (controller.signal.aborted || operation.current !== controller) return;
            afterEventId = event.id;
            if (event.type === 'command.accepted') {
              setLiveStatus(initializing ? '正在理解并建立工作情景' : '已接收');
            } else if (event.type === 'workflow.started') {
              setLiveStatus(initializing ? '正在理解并建立工作情景' : 'Workflow 正在执行');
            } else if (event.type === 'assistant.delta') {
              setLiveStatus(initializing ? '正在理解并建立工作情景' : '正在回复');
              setStreamedReply((current) => current + event.payload.delta);
            } else if (event.type === 'workspace.committed') {
              setLiveStatus(initializing ? '正在理解并建立工作情景' : '成果与 Checkpoint 已生成');
              if (event.payload.pendingInterrupt !== undefined) {
                setPendingInterrupt(event.payload.pendingInterrupt);
                setMessageOwnerKey(interactionOwnerKey);
              }
            }
          });
          if (controller.signal.aborted || operation.current !== controller) {
            throw controller.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
          }
          finished = result.finished;
        } catch (streamError) {
          if (controller.signal.aborted) throw streamError;
          const retryable = !(streamError instanceof CommandApiError) ||
            (streamError.code === 'COMMAND_STREAM_INVALID' && streamError.status < 400);
          if (!retryable || reconnect === 2) throw streamError;
          await new Promise((resolve) => setTimeout(resolve, 100 * (reconnect + 1)));
        }
      }
      if (controller.signal.aborted || operation.current !== controller) {
        throw controller.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      }
      if (!finished) throw new CommandApiError('COMMAND_STREAM_INVALID', 200);
      if (finished.outcome === 'succeeded') {
        setLiveStatus('已完成');
        setFailedAttempt(undefined);
        const currentDraft = latestDraft.current;
        let retainedDraft = currentDraft.ownerKey === logicalOwnerKey ? currentDraft.value : '';
        if (attempt.input.type === 'resume_interrupt') {
          changeInterruptDraft('');
        } else if ('content' in attempt.input) {
          if (currentDraft.ownerKey === logicalOwnerKey && currentDraft.value === attempt.input.content) {
            currentDraft.change('');
            retainedDraft = '';
          }
        }
        const currentAttachments = latestStaged.current;
        let retainedAttachmentIds: string[] = [];
        if (currentAttachments.session === attachmentSession &&
            committedAttachmentSession.current === attachmentSession) {
          const consumedIds = new Set(attempt.attachmentIds);
          const retained = currentAttachments.staged.filter(({ id }) => !consumedIds.has(id));
          retainedAttachmentIds = retained.map(({ id }) => id);
          const settledOwnerScope = finished.conversationId
            ? `${encodeURIComponent(ownerIdentity)}:conversation:${finished.conversationId}`
            : attachmentStorageScope;
          attachmentSession.handoffScope = settledOwnerScope;
          setStagedByOwner((current) => {
            const next = new Map(current);
            if (settledOwnerScope !== currentAttachments.ownerScope) {
              next.delete(currentAttachments.ownerScope);
            }
            next.set(settledOwnerScope, retained);
            return next;
          });
          currentAttachments.onAttachmentIdsChange?.(retainedAttachmentIds);
        }
        onCommandFinished(finished, { draft: retainedDraft, attachmentIds: retainedAttachmentIds });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (conversation && latestInteraction.current.scopeReady &&
            latestInteraction.current.ownerKey === interactionOwnerKey &&
            !controller.signal.aborted) {
          try {
            await reload(controller.signal);
          } catch (loadError) {
            if (!controller.signal.aborted && !isAbort(loadError)) {
              setMessageLoadError({
                ownerKey: interactionOwnerKey,
                message: '命令已完成，但最新消息暂时无法载入。',
              });
            }
          }
        }
        setStreamedReply('');
      } else {
        const code = finished.code ?? (
          finished.outcome === 'conflict' ? 'CHECKPOINT_VERSION_CONFLICT' : 'COMMAND_FAILED'
        );
        setLiveStatus('执行失败');
        setError(errorLabel(code));
        setFailedAttempt(attempt);
        if (finished.outcome === 'conflict') onConflict?.();
      }
    } catch (submitError) {
      if (operation.current === controller && !controller.signal.aborted && !isAbort(submitError)) {
        const code = submitError instanceof CommandApiError ? submitError.code : 'COMMAND_FAILED';
        setLiveStatus('执行失败');
        setError(errorLabel(code));
        setFailedAttempt(attempt);
      }
    } finally {
      if (operation.current === controller) {
        submitting.current = false;
        operation.current = null;
        setBusy(false);
      }
    }
  }, [
    attachmentSession,
    attachmentStorageScope,
    changeInterruptDraft,
    changeDraft,
    checkpoint?.id,
    checkpoint?.version,
    conversation?.id,
    interactionOwnerKey,
    logicalOwnerKey,
    onAttachmentIdsChange,
    onCommandFinished,
    onConflict,
    ownerIdentity,
    reload,
    scopeReady,
    selection.contextId,
    selection.conversationId,
    selection.routeId,
  ]);

  const title = conversation?.title ?? (
    selection.virtualConversationId?.includes(':primary:') ? '主 Conversation' : '未命名 Conversation'
  );
  const statusText = useMemo(() => loading ? '正在载入 Conversation' : liveStatus, [liveStatus, loading]);
  const visibleMessages = messageOwnerKey === interactionOwnerKey ? messages : [];
  const visiblePendingInterrupt = messageOwnerKey === interactionOwnerKey ? pendingInterrupt : null;
  const visibleStreamedReply = streamOwnerKey === interactionOwnerKey ? streamedReply : '';
  const visibleMessageLoadError = messageLoadError.ownerKey === interactionOwnerKey
    ? messageLoadError.message
    : '';
  const failureBelongsToOwner = failureOwner.current === logicalOwnerKey;
  const visibleError = failureBelongsToOwner ? error : '';
  const visibleFailedAttempt = failureBelongsToOwner ? failedAttempt : undefined;
  const interruptAttemptFailed = visibleFailedAttempt?.input.type === 'resume_interrupt';
  const commandFailure = (visibleError && visibleFailedAttempt) ? <div className="command-error" role="alert">
    <span>{visibleError}</span>
    <button type="button" disabled={!scopeReady || busy} onClick={() => void runAttempt({
      input: visibleFailedAttempt.input,
      attachmentIds: [...visibleFailedAttempt.attachmentIds],
    })}>重试</button>
  </div> : visibleError ? <div className="command-error" role="alert">
    <span>{visibleError}</span>
  </div> : null;

  const retryMessageLoad = () => {
    if (!conversation || busy) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setLoading(true);
    setLiveStatus('正在重新载入 Conversation');
    setMessageLoadError({ ownerKey: interactionOwnerKey, message: '' });
    void reload(controller.signal)
      .then(() => {
        if (!controller.signal.aborted && operation.current === controller) setLiveStatus('已保存');
      })
      .catch((loadError) => {
        if (!controller.signal.aborted && !isAbort(loadError) && operation.current === controller) {
          setMessageLoadError({ ownerKey: interactionOwnerKey, message: '消息暂时无法载入。' });
          setLiveStatus('消息同步需要重试');
        }
      })
      .finally(() => {
        if (operation.current === controller) {
          operation.current = null;
          setLoading(false);
        }
      });
  };

  return <section className="conversation" aria-busy={loading || busy} aria-labelledby="conversation-pane-heading">
    <header className="conversation-header">
      <div>
        <p className="card-kicker">Conversation{checkpoint ? ` / ${String(checkpoint.version).padStart(2, '0')}` : ''}</p>
        <h2 id="conversation-pane-heading">{title}</h2>
      </div>
      <span className="conversation-state" role="status" aria-live="polite" aria-atomic="true">
        {statusText}
      </span>
    </header>

    {isHistorical && <p className="history-warning" role="note">
      正在查看历史投影。此版本不可修改；从这里输入会创建一条新时间线，原路线不受影响。
    </p>}

    <div
      className="message-timeline"
      role="log"
      aria-label="Conversation 消息"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {loading && <p className="conversation-empty">正在载入 Conversation…</p>}
      {!loading && visibleMessages.length === 0 && !visibleStreamedReply && <p className="conversation-empty">
        你现在想处理什么？
      </p>}
      {visibleMessages.map((message) => <article
        className={`message-entry message-${message.role}`}
        key={message.id}
      >
        <span>{message.role === 'user' ? '你' : '助手'}</span>
        <p>{message.content}</p>
      </article>)}
      {visibleStreamedReply && <article className="message-entry message-assistant message-streaming">
        <span>助手 · 正在回复</span><p>{visibleStreamedReply}</p>
      </article>}
      {(checkpoint?.snapshot.artifacts ?? []).map((artifact) => <article
        className="message-entry workflow-artifact-entry"
        key={`artifact:${artifact.id}`}
      >
        <a className="download-target" href={downloadUrl({
          kind: 'artifact',
          id: artifact.id,
          filename: artifact.filename,
          mediaType: artifact.media_type,
          byteSize: artifact.byte_size,
          sha256: artifact.sha256,
          createdAt: artifact.created_at,
        })}>
          <span>Workflow 成果 · Checkpoint {String(checkpoint!.version).padStart(2, '0')}</span>
          <strong>{artifact.filename}</strong>
          <small>{artifact.media_type} · {artifact.byte_size} B</small>
        </a>
      </article>)}
    </div>

    {visibleMessageLoadError && <div className="command-error" role="alert">
      <span>{visibleMessageLoadError}</span>
      <button type="button" disabled={busy} onClick={retryMessageLoad}>重新载入消息</button>
    </div>}

    {visiblePendingInterrupt && <form aria-label="Workflow Interrupt" className="interrupt-panel" onSubmit={(event) => {
      event.preventDefault();
      if (!interruptDraft.trim()) return;
      void runAttempt({
        input: { type: 'resume_interrupt', interruptId: visiblePendingInterrupt.id, content: interruptDraft },
        attachmentIds: currentStaged.map(({ id }) => id),
      });
    }}>
      <p className="eyebrow">等待你的决定</p>
      <strong>{visiblePendingInterrupt.prompt}</strong>
      <label>Interrupt 回复
        <textarea
          aria-label="Interrupt 回复"
          value={interruptDraft}
          onChange={(event) => changeInterruptDraft(event.target.value)}
          disabled={busy}
        />
      </label>
      <button type="submit" disabled={!scopeReady || busy || !interruptDraft.trim()}>继续 Workflow</button>
      {interruptAttemptFailed && commandFailure}
    </form>}

    <form className="message-composer" onSubmit={(event) => {
      event.preventDefault();
      if (!draft.trim() || visiblePendingInterrupt) return;
      void runAttempt({
        input: { type: 'message', content: draft },
        attachmentIds: currentStaged.map(({ id }) => id),
      });
    }}>
      <label>Workflow Input
        <textarea
          aria-label="Workflow Input"
          value={draft}
          onChange={(event) => changeDraft(event.target.value)}
          placeholder={visiblePendingInterrupt ? '请先完成上方确认' : '描述问题、目标或粘贴材料……'}
          disabled={Boolean(visiblePendingInterrupt)}
        />
      </label>
      <fieldset disabled={busy} aria-label="附件控制">
        <AttachmentPanel
          key={attachmentOwnerScope}
          staged={currentStaged}
          onChange={changeCurrentOwnerStaged}
          conversationId={conversation?.id}
          draftKey={draftOwnerKey}
        />
      </fieldset>
      <div className="composer-footer">
        <span>{draft ? '未发送 · 已在本机保存' : isHistorical ? '将从所选版本创建新时间线' : 'Input 始终可用'}</span>
        <button
          aria-label="发送 Workflow Input"
          type="submit"
          disabled={!scopeReady || busy || Boolean(visiblePendingInterrupt) || !draft.trim()}
        >{busy ? '执行中…' : '发送'}</button>
      </div>
      {!interruptAttemptFailed && commandFailure}
    </form>

    {intents.length > 0 && <div className="workflow-actions" aria-label="快捷意图">
      {intents.map((intent) => <button
        key={intent.key}
        type="button"
        disabled={!scopeReady || busy || Boolean(visiblePendingInterrupt)}
        onClick={() => void runAttempt({
          input: draft.trim()
            ? { type: 'named_intent', key: intent.key, content: draft }
            : { type: 'named_intent', key: intent.key },
          attachmentIds: currentStaged.map(({ id }) => id),
        })}
      >{intent.label}</button>)}
    </div>}
  </section>;
}

/** @deprecated Use ConversationPane with the Stage-free WorkspaceSelection contract. */
export function ThreadConversation({
  thread,
  checkpoint,
  actions,
  draftScope,
  onCommandFinished,
  onConflict,
}: {
  thread: WorkflowThread;
  stage: StageProjection;
  checkpoint: WorkflowCheckpoint;
  actions: ProductManifest['stages'][number]['actions'];
  draftScope: ComposerDraftScope;
  onCommandFinished: (result: CommandFinishedPayload, retained?: RetainedComposerSnapshot) => void;
  onConflict: () => void;
}) {
  const [draft, setDraft] = useState(() => readComposerDraft(draftScope));
  const conversation: WorkflowConversation = {
    id: thread.id,
    contextId: thread.contextId,
    routeId: thread.routeId,
    title: thread.title,
    titleSource: 'user',
    isPrimary: false,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
  return <ConversationPane
    ownerIdentity={`${draftScope.productId}:${draftScope.userId}`}
    selection={{
      contextId: thread.contextId,
      routeId: thread.routeId,
      conversationId: thread.id,
      checkpointId: checkpoint.id,
    }}
    conversation={conversation}
    checkpoint={checkpoint}
    intents={actions}
    stagedAttachments={[]}
    draft={draft}
    onDraftChange={(value) => {
      setDraft(value);
      writeComposerDraft(draftScope, value);
    }}
    onCommandFinished={onCommandFinished}
    onConflict={onConflict}
  />;
}
