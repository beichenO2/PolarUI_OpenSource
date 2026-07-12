/**
 * Normalize graph engine executeGraph result to harness-compatible { ok, reply, ... } shape.
 * Shared by run-graph-cli and run-graph-server.
 * @param {import('./run-graph.mjs').default extends (...args: infer A) => infer R ? Awaited<R> : never} result
 */
export function normalizeTaociOutput(result) {
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
