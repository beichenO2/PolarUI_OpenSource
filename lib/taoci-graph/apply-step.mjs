import { compileLatex } from './pdf.mjs';
import {
  applyStep0,
  applyStep1,
  applyStep2 as applyStep2Core,
  applyStep3 as applyStep3Core,
  buildHarnessOutput,
} from './apply-step-core.mjs';

export { applyStep0, applyStep1, buildHarnessOutput };

/** Apply Step 2 LLM JSON → session + optional overview PDF */
export async function applyStep2(session, result) {
  return applyStep2Core(session, result, { compileLatex });
}

/** Apply Step 3 LLM JSON → session + prep PDF */
export async function applyStep3(session, result) {
  return applyStep3Core(session, result, { compileLatex });
}
