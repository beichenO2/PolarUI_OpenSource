/**
 * Scenario/Session memory executors — taoci session I/O merged per ADR-007.
 * Replaces TaociSessionLoad / TaociSessionSave (removed).
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  loadSession,
  saveSession,
  appendHistory,
  sessionSummary,
} from '../taoci-graph/session.mjs';
import {
  applyStep0,
  applyStep1,
  applyStep2,
  applyStep3,
  buildHarnessOutput,
} from '../taoci-graph/apply-step.mjs';
import { setActiveSession } from '../taoci-graph/claude-core.mjs';

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

async function extractFileTexts(paths) {
  const parts = [];
  for (const p of paths) {
    try {
      const ext = extname(p).toLowerCase();
      if (['.txt', '.md', '.tex'].includes(ext)) {
        parts.push(`--- ${p} ---\n${await readFile(p, 'utf8')}`);
      } else if (ext === '.pdf') {
        parts.push(`--- ${p} ---\n[PDF 附件，路径: ${p}]`);
      } else {
        parts.push(`--- ${p} ---\n[文件: ${p}]`);
      }
    } catch (e) {
      parts.push(`--- ${p} ---\n[读取失败: ${e instanceof Error ? e.message : String(e)}]`);
    }
  }
  return parts.join('\n\n');
}

let registered = false;

export function resetMemoryRegistration() {
  registered = false;
}

/** @param {Function} registerExecutor */
export function registerMemoryExecutors(registerExecutor) {
  if (registered) return;
  registered = true;
  registerExecutor('UserMemoryLoad', async (node, inputs) => {
    const userId = String(inputs.user_id ?? node.params?.user_id ?? 'default');
    const memory = pickLayer(inputs.memory ?? inputs.memory_snapshot, 'user');
    return {
      outputs: {
        user_id: userId,
        user_memory: memory,
        memory_context: JSON.stringify({ user: memory }),
      },
      duration_ms: 0,
    };
  });

  registerExecutor('ScenarioMemoryLoad', async (node, inputs, ctx) => {
    const conversationId = String(
      inputs.conversation_id
      ?? ctx.runContext?.conversationId
      ?? node.params?.conversation_id
      ?? 'default',
    );
    const message = String(ctx.runContext?.message ?? inputs.message ?? '');
    const files = parseFilesInput(inputs.files ?? ctx.runContext?.files);
    const scenarioMemory = pickLayer(inputs.memory ?? inputs.memory_snapshot, 'scenario');
    const userMemory = pickLayer(inputs.memory ?? inputs.memory_snapshot, 'user');

    const session = await loadSession(conversationId);
    if (files.length) {
      session.student.files = [...new Set([...(session.student.files ?? []), ...files])];
    }
    appendHistory(session, 'user', message);
    setActiveSession(session);
    await saveSession(conversationId, session);

    const fileTexts = await extractFileTexts(files);
    const wmContext = String(inputs.context ?? inputs.memory_context ?? '');
    const branch = session.step;
    const memoryContext = JSON.stringify({ user: userMemory, scenario: scenarioMemory, step: branch });

    return {
      outputs: {
        session,
        step: branch,
        branch,
        value: branch,
        message,
        file_texts: fileTexts,
        memory_context: memoryContext,
        scenario_memory: scenarioMemory,
        conversation_id: conversationId,
        prompt_context: `${wmContext}\n\n当前会话:\n${sessionSummary(session)}\n\n附件:\n${fileTexts || '（无）'}\n\n用户:\n${message}`,
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
        case 'S0_Clarify':
          stepResult = await applyStep0(session, llmResult, fileTexts);
          break;
        case 'S1_Research':
          stepResult = await applyStep1(session, {
            reputation: inputs.reputation ?? inputs.research?.reputation,
            authorship: inputs.authorship ?? inputs.research?.authorship,
            directions: inputs.directions ?? inputs.research?.directions,
          }, llmResult);
          break;
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
    setActiveSession(session);
    await saveSession(conversationId, session);

    const payload = buildHarnessOutput(conversationId, session, stepResult);
    const scenarioDelta = { step: session.step, teacher: session.teacher, student: session.student };

    return {
      outputs: {
        ...payload,
        content: JSON.stringify(payload),
        reply: payload.reply,
        pdf_path: payload.pdf_path,
        step: payload.step,
        branch: session.step,
        memory_delta: { scenario: scenarioDelta },
        state: { branch: session.step, step: session.step, reply: payload.reply, conversation_id: conversationId },
      },
      duration_ms: 0,
    };
  });

  registerExecutor('SessionMemoryLoad', async (node, inputs, ctx) => {
    const sessionId = String(inputs.session_id ?? inputs.conversation_id ?? ctx.runContext?.conversationId ?? 'default');
    const session = await loadSession(sessionId);
    const memory = pickLayer(inputs.memory ?? inputs.memory_snapshot, 'session');
    return {
      outputs: {
        session_id: sessionId,
        session_memory: memory,
        turns: session.history ?? [],
        turns_count: (session.history ?? []).length,
        memory_context: JSON.stringify({ session: memory, turns_count: (session.history ?? []).length }),
      },
      duration_ms: 0,
    };
  });

  registerExecutor('SessionMemorySave', async (node, inputs, ctx) => {
    const sessionId = String(inputs.session_id ?? inputs.conversation_id ?? ctx.runContext?.conversationId ?? 'default');
    const session = await loadSession(sessionId);
    const delta = inputs.memory_delta?.session ?? inputs.session_delta ?? {};
    if (Array.isArray(delta.append_turns)) {
      for (const t of delta.append_turns) {
        appendHistory(session, t.role ?? 'user', t.content ?? '');
      }
    }
    await saveSession(sessionId, session);
    return {
      outputs: {
        session_id: sessionId,
        memory_delta: { session: delta },
        turns_count: (session.history ?? []).length,
      },
      duration_ms: 0,
    };
  });
}

export default registerMemoryExecutors;
