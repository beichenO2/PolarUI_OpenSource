#!/usr/bin/env node
/**
 * PolarUI headless — graph engine 执行 workflow
 * PolarClaw /api/workflow/chat 调用
 */
import { runWorkflowGraph } from '../lib/run-graph.mjs';

function parseArgs(argv) {
  const out = { workflow: '', conversationId: '', message: '', userId: '', files: '' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--workflow') out.workflow = argv[++i];
    else if (argv[i] === '--conversation-id') out.conversationId = argv[++i];
    else if (argv[i] === '--message') out.message = argv[++i];
    else if (argv[i] === '--user-id') out.userId = argv[++i];
    else if (argv[i] === '--files') out.files = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);

if (!args.workflow || !args.conversationId || !args.message) {
  console.error(JSON.stringify({ error: 'missing --workflow --conversation-id --message' }));
  process.exit(1);
}

try {
  const result = await runWorkflowGraph({
    workflowId: args.workflow,
    inputs: {
      conversationId: args.conversationId,
      message: args.message,
      userId: args.userId,
      files: args.files ? args.files.split(',').filter(Boolean) : [],
    },
  });

  console.log(
    JSON.stringify({
      content: typeof result.merged_output === 'string' ? result.merged_output : JSON.stringify(result.merged_output ?? ''),
      node_traces: result.node_traces,
      engine: 'graph',
      ok: result.ok,
      ...result,
    }),
  );
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}
