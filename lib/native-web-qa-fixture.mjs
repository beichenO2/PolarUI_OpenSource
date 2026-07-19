const PREFIXES = {
  artifact: '[qa:artifact]',
  interrupt: '[qa:interrupt]',
  memoryConflict: '[qa:memory-conflict]',
  history: '[qa:history]',
  start: '[qa:start]',
  projectionZero: '[qa:projection:0]',
  projectionOne: '[qa:projection:1]',
  projectionMany: '[qa:projection:many]',
  renameAttempt: '[qa:rename-attempt]',
  reject: '[qa:reject]',
  invalid: '[qa:invalid]',
  timeout: '[qa:timeout]',
};

function stripPrefix(message, prefix) {
  return message.slice(prefix.length).trim();
}

function memoryItems(memory, scope) {
  const value = memory?.[scope];
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.items) ? value.items : [];
}

function expectedVersion(items, key) {
  const item = items.find((candidate) => candidate?.key === key);
  return Number.isInteger(item?.version) && item.version > 0 ? item.version : undefined;
}

function projection(count, baseCheckpointId) {
  return {
    revision: 'qa-dynamic-v1',
    items: Array.from({ length: count }, (_, index) => ({
      key: `dynamic-${index + 1}`,
      label: `动态校验项 ${index + 1}`,
      status: index === 0 ? 'active' : 'not_started',
      ...(index === 0 && baseCheckpointId ? { checkpoint_id: baseCheckpointId } : {}),
    })),
  };
}

function workflowPayload({
  reply,
  workflowState,
  stageProjection,
  contextTitle,
  conversationTitle,
  memoryUpdates = [],
  artifactProposals = [],
  interrupt = null,
}) {
  return {
    ok: true,
    reply,
    contract_version: '2.0',
    reply_events: reply ? [{ type: 'message', content: reply }] : [],
    checkpoint: { workflow_state: workflowState },
    ...(stageProjection === undefined ? {} : { stage_projection: stageProjection }),
    ...(contextTitle === undefined ? {} : { context_title: contextTitle }),
    ...(conversationTitle === undefined ? {} : { conversation_title: conversationTitle }),
    memory_updates: memoryUpdates,
    artifact_proposals: artifactProposals,
    interrupt,
    diagnostics: { workflow_revision: 'native-web-qa-v2', duration_ms: 0 },
  };
}

function createV2Payload({ message, command, memory, history }) {
  const content = String(message ?? '').trim();
  const input = command.input ?? { type: 'message', content };
  const commandId = command.id ?? command.command_id;
  const baseCheckpointId = command.base_checkpoint_id;
  const attachmentIds = Array.isArray(command.attachments) ? command.attachments : [];
  const workflowState = {
    fixture: 'native-web-qa',
    command_id: commandId,
    input_type: input.type,
    message_count: history.length + 1,
    attachment_ids: attachmentIds,
  };

  if (input.type === 'resume_interrupt') {
    return workflowPayload({
      reply: `Fixture resumed · ${input.content}`,
      workflowState: { ...workflowState, resumed_interrupt_id: input.interruptId },
      stageProjection: projection(1, baseCheckpointId),
    });
  }
  if (input.type === 'named_intent') {
    return workflowPayload({
      reply: `Fixture intent · ${input.key}`,
      workflowState: { ...workflowState, named_intent: input.key },
      stageProjection: projection(1, baseCheckpointId),
    });
  }
  if (content.startsWith(PREFIXES.reject)) {
    return { ok: false, reply: 'Fixture rejected command before initialization activation' };
  }
  if (content.startsWith(PREFIXES.invalid)) {
    return { ok: true };
  }
  if (content.startsWith(PREFIXES.projectionZero)) {
    return workflowPayload({
      reply: 'Fixture projection · 0',
      workflowState,
      stageProjection: projection(0, baseCheckpointId),
    });
  }
  if (content.startsWith(PREFIXES.projectionOne)) {
    return workflowPayload({
      reply: 'Fixture projection · 1',
      workflowState,
      stageProjection: projection(1, baseCheckpointId),
    });
  }
  if (content.startsWith(PREFIXES.projectionMany)) {
    return workflowPayload({
      reply: 'Fixture projection · 8',
      workflowState,
      stageProjection: projection(8, baseCheckpointId),
    });
  }
  if (content.startsWith(PREFIXES.start)) {
    const subject = stripPrefix(content, PREFIXES.start);
    const userVersion = expectedVersion(memoryItems(memory, 'user'), 'qa_response_style');
    const contextVersion = expectedVersion(memoryItems(memory, 'context'), 'qa_release_goal');
    return workflowPayload({
      reply: `Fixture initialized · ${subject}`,
      workflowState: { ...workflowState, initialized: true },
      stageProjection: projection(1, baseCheckpointId),
      contextTitle: 'Native Web 发布验证',
      conversationTitle: '核心 Input 验收',
      memoryUpdates: [
        {
          scope: 'user',
          key: 'qa_response_style',
          value: 'concise',
          ...(userVersion === undefined ? {} : { expected_version: userVersion }),
          evidence: [{ kind: 'message', id: 'qa-start-input', excerpt: subject }],
          impact_scope: { context_ids: 'all' },
        },
        {
          scope: 'context',
          key: 'qa_release_goal',
          value: 'verify native workflow release',
          ...(contextVersion === undefined ? {} : { expected_version: contextVersion }),
          evidence: [{ kind: 'message', id: 'qa-start-input', excerpt: subject }],
          impact_scope: { context_ids: [command.context_id] },
        },
      ],
    });
  }
  if (content.startsWith(PREFIXES.renameAttempt)) {
    const subject = stripPrefix(content, PREFIXES.renameAttempt);
    return workflowPayload({
      reply: `Fixture naming attempt · ${subject}`,
      workflowState: { ...workflowState, naming_attempt: true },
      stageProjection: projection(1, baseCheckpointId),
      contextTitle: 'Agent overwrite attempt Context',
      conversationTitle: 'Agent overwrite attempt Conversation',
    });
  }
  if (content.startsWith(PREFIXES.memoryConflict)) {
    const currentVersion = expectedVersion(
      memoryItems(memory, 'context'),
      'release_authority',
    );
    const prompt = '这条高影响记忆与现有事实冲突，请确认。';
    return workflowPayload({
      reply: 'Fixture detected a memory conflict',
      workflowState: { ...workflowState, waiting_for: 'memory_confirmation' },
      stageProjection: projection(1, baseCheckpointId),
      memoryUpdates: [{
        scope: 'context',
        key: 'release_authority',
        value: 'replacement authority',
        ...(currentVersion === undefined ? {} : { expected_version: currentVersion }),
        high_impact: true,
        confirmation_prompt: prompt,
        evidence: [{ kind: 'message', id: 'qa-conflict-input' }],
        impact_scope: { context_ids: [command.context_id] },
      }],
      interrupt: {
        prompt,
        cursor: { kind: 'memory_confirmation', command_id: commandId },
      },
    });
  }
  if (content.startsWith(PREFIXES.interrupt)) {
    return workflowPayload({
      reply: '',
      workflowState: { ...workflowState, waiting_for: 'confirmation' },
      stageProjection: projection(1, baseCheckpointId),
      interrupt: {
        prompt: 'Fixture requires confirmation',
        cursor: { kind: 'fixture_confirmation', command_id: commandId },
      },
    });
  }
  if (content.startsWith(PREFIXES.history)) {
    return workflowPayload({
      reply: `Fixture branched · ${stripPrefix(content, PREFIXES.history)}`,
      workflowState: {
        ...workflowState,
        history_source: {
          checkpoint_id: baseCheckpointId,
          checkpoint_version: command.expected_checkpoint_version,
          input: content,
          messages: history,
        },
      },
      stageProjection: {
        revision: 'qa-history-v1',
        items: [{
          key: 'source',
          label: '历史来源',
          status: 'completed',
          checkpoint_id: baseCheckpointId,
        }],
      },
    });
  }
  if (content.startsWith(PREFIXES.artifact)) {
    const subject = stripPrefix(content, PREFIXES.artifact);
    const attachmentText = attachmentIds.map((id) => ` · attachment ${id}`).join('');
    return workflowPayload({
      reply: `Fixture reply · ${subject}`,
      workflowState,
      stageProjection: projection(1, baseCheckpointId),
      artifactProposals: [{
        filename: 'workflow-report.txt',
        media_type: 'text/plain',
        content_base64: Buffer.from(`artifact · ${subject}${attachmentText}`).toString('base64'),
      }],
    });
  }
  const progressed = history.length >= 2;
  return workflowPayload({
    reply: `Fixture reply · ${content}`,
    workflowState: { ...workflowState, fsm: progressed ? 'deliver' : 'understand' },
    stageProjection: {
      revision: 'qa-message-progress-v1',
      items: [
        {
          key: 'understand',
          label: '理解 Input',
          status: progressed ? 'completed' : 'active',
          ...(baseCheckpointId ? { checkpoint_id: baseCheckpointId } : {}),
        },
        { key: 'deliver', label: '组织交付', status: progressed ? 'active' : 'not_started' },
      ],
    },
  });
}

function createLegacyPayload({ message, command = {}, memory = {} }) {
  const content = String(message ?? '').trim();
  const kind = command.command_kind;
  const action = command.named_action;
  const stage = command.stage_key;

  if (kind === 'resume_interrupt') return {
    ok: true,
    reply: `Fixture resumed · ${content}`,
    workflow_cursor: { stage, resumed: true },
  };
  if (kind === 'named_action' && action === 'adopt_thread') return {
    ok: true,
    reply: 'Fixture adopted thread',
    workflow_cursor: { stage, adopted: true },
  };
  if (content.startsWith(PREFIXES.reject)) return { ok: false, reply: 'Fixture rejected command' };
  if (content.startsWith(PREFIXES.invalid)) return { ok: true };
  if (content.startsWith(PREFIXES.interrupt)) return {
    ok: true,
    reply: 'Fixture requires confirmation',
    memory_delta: { session: { polarflow_pending_run: {
      fixture: 'native-web-qa',
      command_id: command.command_id,
      previous_memory: Boolean(memory?.session?.polarflow_pending_run),
    } } },
  };
  return { ok: true, reply: `Fixture reply · ${content}`, workflow_cursor: { stage } };
}

export function createNativeWebQaPayload({ message, command = {}, memory = {}, history = [] }) {
  return command.contract_version === '2.0' || command.input
    ? createV2Payload({ message, command, memory, history })
    : createLegacyPayload({ message, command, memory });
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
      history: Array.isArray(runContext.history) ? runContext.history : [],
    });
    return {
      outputs: { payload: JSON.stringify(payload) },
      duration_ms: 0,
    };
  });
}
