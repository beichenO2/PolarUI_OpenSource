/**
 * Headless 测试 / taoci mock — 覆盖 LLM executor。
 * 激活：POLARUI_MOCK_LLM=1 或 TAOCI_MOCK_LLM=1
 */
let registered = false;

export function resetMockRegistration() {
  registered = false;
}

/** @param {typeof import('../../dist/assets/index-Dh0id7gB.js').r} registerExecutor */
export function registerMockLLM(registerExecutor) {
  if (registered) return;
  if (process.env.POLARUI_MOCK_LLM !== '1' && process.env.TAOCI_MOCK_LLM !== '1') return;
  registered = true;

  registerExecutor('LLM', async (node, inputs, ctx) => {
    // ReAct smoke（POLARUI_MOCK_LLM）
    if (process.env.POLARUI_MOCK_LLM === '1' && process.env.TAOCI_MOCK_LLM !== '1') {
      const branch = process.env.POLARUI_MOCK_LLM_BRANCH ?? 'tool';
      const payload = { branch, tool: process.env.POLARUI_MOCK_TOOL_NAME ?? 'FileRead' };
      return {
        outputs: {
          response: JSON.stringify(payload),
          branch,
          state: { branch, tool: payload.tool },
        },
        duration_ms: 0,
      };
    }

    // 套辞 workflow — mockForSession（从 session 文件读取最新状态）
    const { complete, setActiveSession } = await import('../taoci-graph/claude-core.mjs');
    const { loadSession, saveSession } = await import('../taoci-graph/session.mjs');
    const convId = String(
      ctx.lgAccumulatedState?.conversation_id
      ?? ctx.runContext?.conversationId
      ?? 'default',
    );
    const session = await loadSession(convId);
    setActiveSession(session);
    const system = String(node.params?.system_prompt ?? '');
    const user = String(inputs.prompt ?? inputs.text ?? '');
    const result = await complete({ system, user, json: true });
    await saveSession(convId, session);
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return {
      outputs: {
        response: text,
        extracted: result,
      },
      duration_ms: 0,
    };
  });
}

export default registerMockLLM;
