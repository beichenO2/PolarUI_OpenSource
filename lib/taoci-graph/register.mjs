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
