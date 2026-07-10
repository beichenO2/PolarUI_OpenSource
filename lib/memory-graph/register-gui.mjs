/**
 * Browser Scenario/Session memory — mirrors headless taoci session I/O.
 */
import {
  loadSession,
  saveSession,
  appendHistory,
  sessionSummary,
} from '../session/session-hub.mjs';
import {
  applyStep0,
  applyStep1,
  applyStep2,
  applyStep3,
  buildHarnessOutput,
} from '../session/apply-step-core.mjs';

function pickLayer(memoryInput, layer) {
  if (!memoryInput || typeof memoryInput !== 'object') return {};
  return memoryInput[layer] ?? {};
}

function parseFilesInput(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** @param {Function} registerExecutor */
export function registerMemoryGuiExecutors(registerExecutor) {
  registerExecutor('UserMemoryLoad', async (node, inputs) => {
    const userId = String(inputs.user_id ?? node.params?.user_id ?? 'default');
    const memory = pickLayer(inputs.memory ?? inputs.memory_snapshot, 'user');
    return {
      outputs: { user_id: userId, user_memory: memory, memory_context: JSON.stringify({ user: memory }) },
      duration_ms: 0,
    };
  });

  registerExecutor('ScenarioMemoryLoad', async (node, inputs, ctx) => {
    const conversationId = String(inputs.conversation_id ?? ctx.runContext?.conversationId ?? 'default');
    const message = String(ctx.runContext?.message ?? inputs.message ?? '');
    const files = parseFilesInput(inputs.files ?? ctx.runContext?.files);
    const scenarioMemory = pickLayer(inputs.memory ?? inputs.memory_snapshot, 'scenario');

    const session = await loadSession(conversationId);
    if (files.length) {
      session.student.files = [...new Set([...(session.student.files ?? []), ...files])];
    }
    appendHistory(session, 'user', message);
    await saveSession(conversationId, session);

    const fileTexts = files.length
      ? files.map((p) => `--- ${p} ---\n[附件: ${p}]`).join('\n\n')
      : '';
    const branch = session.step;
    const wmContext = String(inputs.context ?? inputs.memory_context ?? '');

    return {
      outputs: {
        session,
        step: branch,
        branch,
        value: branch,
        message,
        file_texts: fileTexts,
        memory_context: JSON.stringify({ scenario: scenarioMemory, step: branch }),
        scenario_memory: scenarioMemory,
        conversation_id: conversationId,
        prompt_context: `${wmContext}\n\n${sessionSummary(session)}\n\n${message}`,
        state: { branch, step: branch, conversation_id: conversationId, message, session },
      },
      duration_ms: 0,
    };
  });

  registerExecutor('ScenarioMemorySave', async (node, inputs, ctx) => {
    const conversationId = String(inputs.conversation_id ?? ctx.runContext?.conversationId ?? 'default');
    const session = await loadSession(conversationId);
    const step = String(node.params?.step ?? inputs.step ?? session.step);
    const llmResult = inputs.llm_result ?? inputs.response ?? inputs.extracted ?? inputs.result;
    const fileTexts = String(inputs.file_texts ?? '');

    let stepResult;
    try {
      switch (step) {
        case 'S0_Clarify': stepResult = await applyStep0(session, llmResult, fileTexts); break;
        case 'S1_Research':
          stepResult = await applyStep1(session, {
            reputation: inputs.reputation,
            authorship: inputs.authorship,
            directions: inputs.directions,
          }, llmResult);
          break;
        case 'S2_Select': stepResult = await applyStep2(session, llmResult); break;
        case 'S3_DeepPrep': stepResult = await applyStep3(session, llmResult); break;
        default: stepResult = { reply: '未知步骤', step: session.step, error: true };
      }
    } catch (err) {
      stepResult = { reply: String(err), step: session.step, error: true };
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
        memory_delta: { scenario: { step: session.step } },
        branch: session.step,
      },
      duration_ms: 0,
    };
  });

  registerExecutor('SessionMemoryLoad', async (node, inputs, ctx) => {
    const sessionId = String(inputs.session_id ?? ctx.runContext?.conversationId ?? 'default');
    const session = await loadSession(sessionId);
    const memory = pickLayer(inputs.memory ?? inputs.memory_snapshot, 'session');
    return {
      outputs: {
        session_id: sessionId,
        session_memory: memory,
        turns: session.history ?? [],
        turns_count: (session.history ?? []).length,
      },
      duration_ms: 0,
    };
  });

  registerExecutor('SessionMemorySave', async (node, inputs, ctx) => {
    const sessionId = String(inputs.session_id ?? ctx.runContext?.conversationId ?? 'default');
    const session = await loadSession(sessionId);
    const delta = inputs.memory_delta?.session ?? {};
    if (Array.isArray(delta.append_turns)) {
      for (const t of delta.append_turns) appendHistory(session, t.role ?? 'user', t.content ?? '');
    }
    await saveSession(sessionId, session);
    return { outputs: { session_id: sessionId, turns_count: (session.history ?? []).length }, duration_ms: 0 };
  });
}

export default registerMemoryGuiExecutors;
