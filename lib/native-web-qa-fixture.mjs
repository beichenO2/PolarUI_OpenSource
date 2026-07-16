const PREFIXES = {
  artifact: '[qa:artifact]',
  interrupt: '[qa:interrupt]',
  reject: '[qa:reject]',
  invalid: '[qa:invalid]',
  timeout: '[qa:timeout]',
};

function stripPrefix(message, prefix) {
  return message.slice(prefix.length).trim();
}

export function createNativeWebQaPayload({ message, command = {}, memory = {} }) {
  const content = String(message ?? '').trim();
  const kind = command.command_kind;
  const action = command.named_action;
  const stage = command.stage_key;

  if (kind === 'resume_interrupt') {
    return {
      ok: true,
      reply: `Fixture resumed · ${content}`,
      workflow_cursor: { stage, resumed: true },
    };
  }
  if (kind === 'named_action' && action === 'adopt_thread') {
    return {
      ok: true,
      reply: 'Fixture adopted thread',
      workflow_cursor: { stage, adopted: true },
    };
  }
  if (kind === 'named_action' && action === 'advance') {
    const stageSignals = stage === 'work'
      ? [
          { stage_key: 'discover', status: 'completed', internal_state: 'done' },
          { stage_key: 'work', status: 'completed', internal_state: 'done' },
          { stage_key: 'review', status: 'active', internal_state: 'running' },
        ]
      : [
          { stage_key: 'discover', status: 'completed', internal_state: 'done' },
          { stage_key: 'work', status: 'active', internal_state: 'running' },
        ];
    return {
      ok: true,
      reply: stage === 'work' ? 'Fixture advanced to review' : 'Fixture advanced to work',
      stage_signals: stageSignals,
      workflow_cursor: { stage: stage === 'work' ? 'review' : 'work' },
    };
  }
  if (content.startsWith(PREFIXES.reject)) {
    return { ok: false, reply: 'Fixture rejected command' };
  }
  if (content.startsWith(PREFIXES.invalid)) {
    return { ok: true };
  }
  if (content.startsWith(PREFIXES.interrupt)) {
    return {
      ok: true,
      reply: 'Fixture requires confirmation',
      memory_delta: {
        session: {
          polarflow_pending_run: {
            fixture: 'native-web-qa',
            command_id: command.command_id,
            previous_memory: Boolean(memory?.session?.polarflow_pending_run),
          },
        },
      },
    };
  }
  if (content.startsWith(PREFIXES.artifact)) {
    const subject = stripPrefix(content, PREFIXES.artifact);
    return {
      ok: true,
      reply: `Fixture reply · ${subject}`,
      memory_proposals: [{ scope: 'context', key: 'qa_fact', value: subject }],
      artifact_proposals: [{
        filename: 'workflow-report.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from(`artifact · ${subject}`).toString('base64'),
      }],
      workflow_cursor: { stage, command_id: command.command_id },
    };
  }
  return {
    ok: true,
    reply: `Fixture reply · ${content}`,
    workflow_cursor: { stage, command_id: command.command_id },
  };
}

export function registerNativeWebQaFixture(registerExecutor) {
  registerExecutor('NativeWebQaFixture', async (_node, _inputs, context) => {
    const runContext = context.runContext ?? {};
    const message = String(runContext.user_message ?? '');
    if (message.startsWith(PREFIXES.timeout)) {
      await new Promise((resolve) => setTimeout(
        resolve,
        Number(process.env.NATIVE_WEB_QA_TIMEOUT_MS ?? 250),
      ));
    }
    const payload = createNativeWebQaPayload({
      message,
      command: runContext.command,
      memory: runContext.memory,
    });
    return {
      outputs: { payload: JSON.stringify(payload) },
      duration_ms: 0,
    };
  });
}
