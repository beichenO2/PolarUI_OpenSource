import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import {
  loadSession,
  saveSession,
  appendHistory,
  sessionSummary,
} from './session.mjs';
import {
  applyStep0,
  applyStep1,
  applyStep2,
  applyStep3,
  buildHarnessOutput,
} from './apply-step.mjs';
import { runReputationAgent, runAuthorshipAgent, runDirectionsAgent } from './subagents.mjs';
import { setActiveSession } from './claude-core.mjs';

async function extractFileTexts(paths) {
  const parts = [];
  for (const p of paths) {
    try {
      const ext = extname(p).toLowerCase();
      if (['.txt', '.md', '.tex'].includes(ext)) {
        parts.push(`--- ${p} ---\n${await readFile(p, 'utf8')}`);
      } else if (ext === '.pdf') {
        parts.push(`--- ${p} ---\n[PDF 附件，路径: ${p}，请结合用户文字理解]`);
      } else {
        parts.push(`--- ${p} ---\n[二进制/Office 文件: ${p}]`);
      }
    } catch (e) {
      parts.push(`--- ${p} ---\n[读取失败: ${e.message}]`);
    }
  }
  return parts.join('\n\n');
}

function parseFilesInput(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

let registered = false;

export function resetTaociRegistration() {
  registered = false;
}

/** @param {typeof import('../../dist/assets/index-Dh0id7gB.js').r} registerExecutor */
export function registerTaociExecutors(registerExecutor) {
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
    setActiveSession(session);
    await saveSession(conversationId, session);

    const fileTexts = await extractFileTexts(files);
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
    setActiveSession(session);
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
    const agentCtx = {
      teacher: session?.teacher ?? {},
      student: session?.student ?? {},
      userMessage: String(inputs.message ?? ctx.runContext?.message ?? ''),
    };

    let result;
    switch (agent) {
      case 'authorship':
        result = await runAuthorshipAgent(agentCtx);
        break;
      case 'directions':
        result = await runDirectionsAgent(agentCtx);
        break;
      default:
        result = await runReputationAgent(agentCtx);
    }

    return {
      outputs: {
        result,
        status: result.status ?? 'done',
        agent,
        [agent]: result,
      },
      duration_ms: 0,
    };
  });
}
