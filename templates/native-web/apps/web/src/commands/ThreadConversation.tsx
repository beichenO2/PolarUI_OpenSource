import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductManifest } from '@polar/native-web-product-sdk';
import type { StageProjection, WorkflowCheckpoint, WorkflowThread } from '../domain/api';
import {
  CommandApiError,
  createCommand,
  listThreadMessages,
  streamCommandEvents,
  type CommandFinishedPayload,
  type CommandInput,
  type PublicWorkflowInterrupt,
  type WorkflowMessage,
} from './api';

function commandId() {
  return globalThis.crypto?.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const value = Math.floor(Math.random() * 16);
      return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
    });
}

function errorLabel(code: string) {
  const labels: Record<string, string> = {
    WORKFLOW_TIMEOUT: '工作流响应超时，命令不会自动重试。',
    WORKFLOW_UNAVAILABLE: '工作流暂时不可用，请稍后重新提交。',
    CHECKPOINT_VERSION_CONFLICT: '路线已发生变化。刷新后可选择最新状态，或从当前历史检查点创建新路线。',
    COMMAND_IN_PROGRESS: '这条命令仍在执行，请稍候。',
  };
  return labels[code] ? `${labels[code]}（${code}）` : code;
}

export function ThreadConversation({
  thread,
  stage,
  checkpoint,
  actions,
  onCommandFinished,
  onConflict,
}: {
  thread: WorkflowThread;
  stage: StageProjection;
  checkpoint: WorkflowCheckpoint;
  actions: ProductManifest['stages'][number]['actions'];
  onCommandFinished: (result: CommandFinishedPayload) => void;
  onConflict: () => void;
}) {
  const [messages, setMessages] = useState<WorkflowMessage[]>([]);
  const [pendingInterrupt, setPendingInterrupt] = useState<PublicWorkflowInterrupt | null>(null);
  const [draft, setDraft] = useState('');
  const [interruptDraft, setInterruptDraft] = useState('');
  const [streamedReply, setStreamedReply] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const observation = useRef<AbortController | null>(null);
  const submitting = useRef(false);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const state = await listThreadMessages(thread.id, { signal });
    setMessages(state.messages);
    setPendingInterrupt(state.pendingInterrupt);
  }, [thread.id]);

  useEffect(() => {
    const controller = new AbortController();
    observation.current?.abort();
    observation.current = controller;
    setLoading(true);
    setError('');
    setStreamedReply('');
    void reload(controller.signal)
      .catch((loadError) => {
        if (!(loadError instanceof DOMException && loadError.name === 'AbortError')) {
          setError('消息暂时无法载入。');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => () => {
    observation.current?.abort();
    observation.current = null;
  }, []);

  const submit = useCallback(async (
    input: Omit<CommandInput, 'commandId' | 'baseCheckpointId' | 'expectedCheckpointVersion'>,
    source: 'message' | 'interrupt' | 'action',
  ) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    setStreamedReply('');
    const controller = new AbortController();
    observation.current?.abort();
    observation.current = controller;
    const stableCommandId = commandId();
    try {
      const receipt = await createCommand(thread.id, {
        ...input,
        commandId: stableCommandId,
        baseCheckpointId: checkpoint.id,
        expectedCheckpointVersion: checkpoint.version,
      } as CommandInput, { signal: controller.signal });
      let afterEventId = 0;
      let finished: CommandFinishedPayload | null = null;
      for (let attempt = 0; attempt < 3 && !finished; attempt++) {
        try {
          const result = await streamCommandEvents(
            receipt.eventUrl,
            { afterEventId, signal: controller.signal },
            (event) => {
              afterEventId = event.id;
              if (event.type === 'assistant.delta') {
                setStreamedReply((current) => current + event.payload.delta);
              }
            },
          );
          finished = result.finished;
        } catch (streamError) {
          if (controller.signal.aborted) throw streamError;
          const retryable = !(streamError instanceof CommandApiError) ||
            (streamError.code === 'COMMAND_STREAM_INVALID' && streamError.status < 400);
          if (!retryable || attempt === 2) {
            throw streamError;
          }
          await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
      if (!finished) throw new CommandApiError('COMMAND_STREAM_INVALID', 200);
      if (finished.outcome === 'succeeded') {
        if (source === 'message') setDraft('');
        if (source === 'interrupt') setInterruptDraft('');
        await reload(controller.signal);
        onCommandFinished(finished);
        setStreamedReply('');
      } else {
        const code = finished.code ?? (finished.outcome === 'conflict' ? 'CHECKPOINT_VERSION_CONFLICT' : 'COMMAND_FAILED');
        setError(errorLabel(code));
        if (finished.outcome === 'conflict') onConflict();
      }
    } catch (submitError) {
      if (!(submitError instanceof DOMException && submitError.name === 'AbortError')) {
        const code = submitError instanceof CommandApiError ? submitError.code : 'COMMAND_FAILED';
        setError(errorLabel(code));
      }
    } finally {
      submitting.current = false;
      if (observation.current === controller) setBusy(false);
    }
  }, [checkpoint.id, checkpoint.version, onCommandFinished, onConflict, reload, thread.id]);

  return <section className="conversation" aria-busy={loading || busy}>
    <header className="conversation-header">
      <div>
        <p className="card-kicker">Thread / {String(checkpoint.version).padStart(2, '0')}</p>
        <h2>{thread.title}</h2>
      </div>
      <span className="conversation-state">{busy ? '工作流执行中' : '消息已持久化'}</span>
    </header>

    <div className="message-timeline" aria-live="polite">
      {loading && <p className="conversation-empty">正在载入讨论记录…</p>}
      {!loading && messages.length === 0 && !streamedReply && <p className="conversation-empty">
        从一个具体问题开始。消息只属于当前线程；共享状态必须通过下方受控动作改变。
      </p>}
      {messages.map((message) => <article
        className={`message-entry message-${message.role}`}
        key={message.id}
      >
        <span>{message.role === 'user' ? '你' : 'Workflow'}</span>
        <p>{message.content}</p>
      </article>)}
      {streamedReply && <article className="message-entry message-assistant message-streaming">
        <span>Workflow · streaming</span><p>{streamedReply}</p>
      </article>}
    </div>

    {pendingInterrupt && <form className="interrupt-panel" onSubmit={(event) => {
      event.preventDefault();
      if (!interruptDraft.trim()) return;
      void submit({
        kind: 'resume_interrupt',
        interruptId: pendingInterrupt.id,
        content: interruptDraft,
      }, 'interrupt');
    }}>
      <p className="eyebrow">等待你的决定</p>
      <strong>{pendingInterrupt.prompt}</strong>
      <label>中断回复
        <textarea aria-label="中断回复" value={interruptDraft} onChange={(event) => setInterruptDraft(event.target.value)} />
      </label>
      <button type="submit" disabled={busy || !interruptDraft.trim()}>继续工作流</button>
    </form>}

    <form className="message-composer" onSubmit={(event) => {
      event.preventDefault();
      if (!draft.trim() || pendingInterrupt) return;
      void submit({ kind: 'message', content: draft }, 'message');
    }}>
      <label>消息内容
        <textarea
          aria-label="消息内容"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={pendingInterrupt ? '请先回复工作流中断' : '写下当前线程要继续讨论的问题…'}
          disabled={Boolean(pendingInterrupt)}
        />
      </label>
      <div className="composer-footer">
        <span>{stage.status === 'not_started' ? '可提前讨论；受控动作暂不可用' : `${stage.label} · ${stage.internalState}`}</span>
        <button aria-label="发送消息" type="submit" disabled={busy || Boolean(pendingInterrupt) || !draft.trim()}>
          {busy ? '执行中…' : '发送'}
        </button>
      </div>
    </form>

    <div className="workflow-actions" aria-label="受控工作流动作">
      {actions.map((action) => <button
        key={action.key}
        type="button"
        disabled={busy || stage.status === 'not_started' || Boolean(pendingInterrupt)}
        onClick={() => void submit({ kind: 'named_action', actionKey: action.key, content: action.label }, 'action')}
      >{action.label}</button>)}
    </div>
    {error && <p className="command-error" role="alert">{error}</p>}
  </section>;
}
