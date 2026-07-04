#!/usr/bin/env node
/**
 * CLI: execute PolarUI workflow via graph engine (executeGraph).
 * Usage:
 *   node lib/run-graph-cli.mjs --workflow taoci-outreach --conversation-id x --message "..."
 */
import { runWorkflowGraph } from './run-graph.mjs';

function parseArgs(argv) {
  const out = { workflow: '', conversationId: '', message: '', userId: '', files: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workflow') out.workflow = argv[++i];
    else if (a === '--conversation-id') out.conversationId = argv[++i];
    else if (a === '--message') out.message = argv[++i];
    else if (a === '--user-id') out.userId = argv[++i];
    else if (a === '--files') out.files = argv[++i];
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

  const payload = normalizeTaociOutput(result);
  console.log(JSON.stringify(payload));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}

/** Map graph outputs to harness-compatible shape for PolarClaw bridge. */
function normalizeTaociOutput(result) {
  let harnessJson = null;
  for (const nodeResult of Object.values(result.outputs ?? {})) {
    const outs = nodeResult?.outputs ?? {};
    for (const val of [outs.content, outs.stdout, outs.result]) {
      if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val);
          if (parsed && (parsed.reply != null || parsed.ok != null || parsed.step != null)) {
            harnessJson = parsed;
          }
        } catch {
          /* not json */
        }
      }
    }
  }

  if (harnessJson) {
    return {
      ok: harnessJson.ok ?? result.ok,
      reply: harnessJson.reply ?? harnessJson.error,
      step: harnessJson.step,
      pdf_path: harnessJson.pdf_path ?? null,
      node_traces: result.node_traces,
      engine: 'graph',
      ...harnessJson,
    };
  }

  return {
    ok: result.ok,
    reply: typeof result.merged_output === 'string' ? result.merged_output : JSON.stringify(result.merged_output ?? ''),
    content: result.merged_output,
    node_traces: result.node_traces,
    engine: 'graph',
  };
}
