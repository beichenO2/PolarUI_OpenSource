/**
 * petri-dish.ts — PetriDish sandbox differentiation (ADR-014 D3).
 *
 * Deep-copies a slave workflow, evaluates candidate mutations via an injected
 * execute() callback, returns the best refined workflow. Never mutates the
 * input slave. Persistence is human-gated via lib/save-petri-result.mjs (.petri.json).
 */
import {
  applyMutations,
  type MutationOp,
  type MutationPolicy,
} from './graph-mutation'
import type { Workflow } from './types'

export interface PetriEvolutionSignal {
  /** Single candidate mutation set (treated as candidates: [ops]). */
  ops?: MutationOp[]
  /** Multiple candidate mutation sets to evaluate. */
  candidates?: MutationOp[][]
}

export interface PetriDishInput {
  slaveWorkflow: Workflow
  seed?: unknown
  evolutionSignal?: PetriEvolutionSignal
  policy: MutationPolicy
  execute: (
    wf: Workflow,
    seed?: unknown,
  ) => Promise<{ ok: boolean; score?: number; outputs?: unknown }>
}

export interface PetriEvaluation {
  candidateIndex: number
  ok: boolean
  score?: number
}

export interface PetriDishResult {
  refinedWorkflow: Workflow
  /** Human-gated: always false until an explicit apply path is used. */
  applied: false
  evaluations: PetriEvaluation[]
}

function deepCloneWorkflow(wf: Workflow): Workflow {
  return structuredClone(wf)
}

function resolveCandidates(signal?: PetriEvolutionSignal): MutationOp[][] {
  if (signal?.candidates && signal.candidates.length > 0) {
    return signal.candidates
  }
  if (signal?.ops) {
    return [signal.ops]
  }
  return [[]]
}

/**
 * Evaluate candidate mutations in a sandbox. Input slaveWorkflow is never mutated.
 * Best ok+highest-score candidate wins; all failures → deep clone of original.
 */
export async function runPetriDish(input: PetriDishInput): Promise<PetriDishResult> {
  const { slaveWorkflow, seed, evolutionSignal, policy, execute } = input
  const candidates = resolveCandidates(evolutionSignal)
  const evaluations: PetriEvaluation[] = []

  let best: { workflow: Workflow; score: number } | null = null

  for (let i = 0; i < candidates.length; i++) {
    const { workflow: mutated } = applyMutations(slaveWorkflow, candidates[i], policy)
    const evalResult = await execute(mutated, seed)
    const score = evalResult.score ?? 0
    evaluations.push({
      candidateIndex: i,
      ok: evalResult.ok,
      score: evalResult.score,
    })
    if (evalResult.ok) {
      if (!best || score > best.score) {
        best = { workflow: mutated, score }
      }
    }
  }

  return {
    refinedWorkflow: best ? best.workflow : deepCloneWorkflow(slaveWorkflow),
    applied: false,
    evaluations,
  }
}
