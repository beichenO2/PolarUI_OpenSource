#!/usr/bin/env node
/**
 * CLI: execute PolarUI workflow via graph engine (executeGraph).
 * Usage:
 *   node lib/run-graph-cli.mjs --workflow claude-code --conversation-id x --message "..."
 */
import { runWorkflowGraph } from './run-graph.mjs';
import { normalizeTaociOutput } from './run-graph-output.mjs';

function parseArgs(argv) {
  const out = { workflow: '', conversationId: '', message: '', userId: '', files: '', memoryJson: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow') out.workflow = argv[++i];
    else if (a === '--conversation-id') out.conversationId = argv[++i];
    else if (a === '--message') out.message = argv[++i];
    else if (a === '--user-id') out.userId = argv[++i];
    else if (a === '--files') out.files = argv[++i];
    else if (a === '--memory-json') out.memoryJson = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
if (!args.workflow || !args.conversationId || !args.message) {
  console.error(JSON.stringify({ error: 'missing --workflow --conversation-id --message' }));
  process.exit(1);
}

try {
  const memory = args.memoryJson ? JSON.parse(args.memoryJson) : {};
  const result = await runWorkflowGraph({
    workflowId: args.workflow,
    inputs: {
      conversationId: args.conversationId,
      message: args.message,
      userId: args.userId,
      files: args.files ? args.files.split(',').filter(Boolean) : [],
      memory,
    },
  });

  const payload = normalizeTaociOutput(result);
  console.log(JSON.stringify(payload));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}
