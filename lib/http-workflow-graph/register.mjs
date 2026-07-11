/**
 * HttpWorkflow executor — headless graph overlay (ADR-012).
 */
import { runHttpWorkflow } from './run-http-workflow.mjs';

let registered = false;

export function resetHttpWorkflowRegistration() {
  registered = false;
}

/** @param {Function} registerExecutor */
export function registerHttpWorkflowExecutors(registerExecutor) {
  if (registered) return;
  registered = true;

  registerExecutor('HttpWorkflow', async (node, inputs, ctx) =>
    runHttpWorkflow({ params: node.params ?? {}, inputs, ctx }),
  );
}

export default registerHttpWorkflowExecutors;
