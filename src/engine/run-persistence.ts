/**
 * Run trace 落盘 — 开发期经 run-trace-bridge (3922) 写 PolarUI/runs/
 */
import type { RunTraceEnvelope } from './executor'
import type { LGRunResult } from './lg-runner'

const BRIDGE = 'http://127.0.0.1:3922'

export async function persistRunTrace(envelope: RunTraceEnvelope): Promise<string | null> {
  try {
    const res = await fetch(`${BRIDGE}/api/runs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { log_path?: string }
    return data.log_path ?? null
  } catch {
    try {
      localStorage.setItem(`polarui-run-${envelope.run_id}`, JSON.stringify(envelope))
    } catch { /* headless */ }
    return null
  }
}

/** LG Spec execute 落盘 run.json + trace.jsonl（08 §3.1） */
export async function persistLGRun(
  specName: string,
  result: LGRunResult,
): Promise<{ log_path?: string; run_path?: string } | null> {
  const trace = result.runTrace
  if (!trace) return null
  const envelope = {
    ...trace,
    library: 'LG' as const,
    spec_id: specName,
    steps: result.steps,
    materialized_graph: result.materialized_graph,
    merged_output: result.merged_output,
  }
  try {
    const res = await fetch(`${BRIDGE}/api/runs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    return (await res.json()) as { log_path?: string; run_path?: string }
  } catch {
    return null
  }
}
