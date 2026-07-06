/**
 * Browser GUI overlay — TaociSessionLoad / Save / SubAgent executors.
 * Uses session-hub (Hub file API + in-memory fallback), no node:fs.
 */
import {
  loadSession,
  saveSession,
  appendHistory,
  sessionSummary,
} from './session-hub.mjs';
import {
  applyStep0,
  applyStep1,
  applyStep2,
  applyStep3,
  buildHarnessOutput,
} from './apply-step-core.mjs';

function parseFilesInput(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

let registered = false;

export function resetTaociGuiRegistration() {
  registered = false;
}

/** @param {Function} registerExecutor */
export function registerTaociGuiExecutors(registerExecutor) {
  if (registered) return;
  registered = true;

  registerExecutor('TaociSessionLoad', async (node, inputs, ctx) => {
    const conversationId = String(
      inputs.conversation_id
      ?? ctx.runContext?.conversationId
      ?? node.params.conversation_id
      ?? 'default',
    );
    const message = String(
      ctx.runContext?.message
      ?? inputs.message
      ?? node.params.message
      ?? '',
    );
    const files = parseFilesInput(inputs.files ?? ctx.runContext?.files);

    const session = await loadSession(conversationId);
    if (files.length) {
      session.student.files = [...new Set([...(session.student.files ?? []), ...files])];
    }
    appendHistory(session, 'user', message);
    await saveSession(conversationId, session);

    const fileTexts = files.length
      ? files.map((p) => `--- ${p} ---\n[附件路径: ${p}]`).join('\n\n')
      : '';

    const memoryContext = String(inputs.context ?? inputs.memory_context ?? '');
    const branch = session.step;
    const state = {
      branch,
      step: branch,
      conversation_id: conversationId,
      message,
      task: message,
      session,
    };

    return {
      outputs: {
        session,
        step: branch,
        branch,
        value: branch,
        message,
        file_texts: fileTexts,
        memory_context: memoryContext,
        conversation_id: conversationId,
        prompt_context: `当前会话状态:\n${sessionSummary(session)}\n\n用户附件摘要:\n${fileTexts || '（无）'}\n\n用户消息:\n${message}`,
        state,
      },
      duration_ms: 0,
    };
  });

  registerExecutor('TaociSessionSave', async (node, inputs, ctx) => {
    const conversationId = String(
      inputs.conversation_id
      ?? ctx.runContext?.conversationId
      ?? 'default',
    );
    const session = await loadSession(conversationId);
    const step = String(node.params.step ?? inputs.step ?? session.step);
    const llmResult = inputs.llm_result ?? inputs.response ?? inputs.extracted ?? inputs.result;
    const fileTexts = String(inputs.file_texts ?? '');

    let stepResult;
    try {
      switch (step) {
        case 'S0_Clarify':
          stepResult = await applyStep0(session, llmResult, fileTexts);
          break;
        case 'S1_Research': {
          const research = {
            reputation: inputs.reputation ?? inputs.research?.reputation,
            authorship: inputs.authorship ?? inputs.research?.authorship,
            directions: inputs.directions ?? inputs.research?.directions,
          };
          stepResult = await applyStep1(session, research, llmResult);
          break;
        }
        case 'S2_Select':
          stepResult = await applyStep2(session, llmResult);
          break;
        case 'S3_DeepPrep':
          stepResult = await applyStep3(session, llmResult);
          break;
        default:
          stepResult = { reply: '未知步骤', step: session.step, error: true };
      }
    } catch (err) {
      stepResult = {
        reply: `处理出错: ${err instanceof Error ? err.message : String(err)}`,
        step: session.step,
        error: true,
      };
    }

    appendHistory(session, 'assistant', stepResult.reply);
    await saveSession(conversationId, session);

    const payload = buildHarnessOutput(conversationId, session, stepResult);
    return {
      outputs: {
        ...payload,
        content: JSON.stringify(payload),
        reply: payload.reply,
        pdf_path: payload.pdf_path,
        step: payload.step,
        branch: session.step,
        state: {
          branch: session.step,
          step: session.step,
          reply: payload.reply,
          conversation_id: conversationId,
        },
      },
      duration_ms: 0,
    };
  });

  registerExecutor('TaociSubAgent', async (node, inputs, ctx) => {
    const conversationId = String(
      inputs.conversation_id
      ?? ctx.runContext?.conversationId
      ?? 'default',
    );
    const session = inputs.session ?? await loadSession(conversationId);
    const agent = String(node.params.agent ?? 'reputation');

    return {
      outputs: {
        result: {
          status: 'stub',
          agent,
          note: 'TaociSubAgent GUI stub — 完整调研请用 CLI/headless 路径',
        },
        status: 'stub',
        agent,
        [agent]: { status: 'stub' },
      },
      duration_ms: 0,
    };
  });
}

export default registerTaociGuiExecutors;
