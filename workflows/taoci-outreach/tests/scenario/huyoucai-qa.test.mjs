import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TEACHER, STUDENT_PROFILE } from '../mocks/llm-responses.mjs';

describe('scenario QA: 胡友财套辞（郭韵怡）', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'taoci-scenario-'));
    process.env.TAOCI_USE_CLAUDE_CLI = '0';
    process.env.TAOCI_MOCK_LLM = '1';
    process.env.TAOCI_MOCK_PDF = '1';
    process.env.TAOCI_SESSION_DIR = tmpDir;
    delete process.env.POLARUI_MOCK_LLM;
    delete process.env.POLARUI_MOCK_TOOLCALL;
    const { resetHeadlessEngine } = await import('../../../../lib/headless-engine.mjs');
    const { resetMockRegistration } = await import('../../../../lib/test-mocks/register.mjs');
    const { resetTaociRegistration } = await import('../../../../lib/taoci-graph/register.mjs');
    resetHeadlessEngine();
    resetMockRegistration();
    resetTaociRegistration();
  });

  after(async () => {
    delete process.env.TAOCI_USE_CLAUDE_CLI;
    delete process.env.TAOCI_MOCK_LLM;
    delete process.env.TAOCI_MOCK_PDF;
    delete process.env.TAOCI_SESSION_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('full multi-turn conversation reaches done with PDF + QA (graph engine)', async () => {
    const { runWorkflowGraph } = await import('../../../../lib/run-graph.mjs');
    const conv = `qa-huyoucai-${Date.now()}`;
    const turns = [
      '想套辞胡友财老师，药大制药工程大三',
      STUDENT_PROFILE,
      '继续调研',
      '看看套辞话术',
      '确认方向 A',
      '生成深度准备材料',
    ];

    let last;
    for (const msg of turns) {
      const result = await runWorkflowGraph({
        workflowId: 'taoci-outreach',
        inputs: { conversationId: conv, message: msg },
      });
      assert.ok(result.ok, `graph run failed: ${msg}`);

      let parsed = null;
      for (const nodeResult of Object.values(result.outputs ?? {})) {
        const outs = nodeResult?.outputs ?? {};
        for (const val of [outs.content, outs.stdout, outs.reply]) {
          if (typeof val !== 'string') continue;
          try {
            const j = JSON.parse(val);
            if (j && (j.reply != null || j.step != null)) parsed = j;
          } catch { /* skip */ }
        }
      }
      last = parsed ?? { ok: result.ok, reply: String(result.merged_output ?? '') };
      assert.equal(last.ok ?? true, true, `turn failed: ${msg} → ${JSON.stringify(last)}`);
    }

    assert.equal(last.step, 'done');
    assert.equal(last.session_snapshot?.teacher?.name ?? last.teacher?.name, TEACHER.name);
    assert.ok(last.session_snapshot?.selected_direction ?? last.selected_direction);
    assert.ok(Array.isArray(last.mock_qa));
    assert.ok(last.mock_qa.length >= 10);
    assert.ok(last.pdf_path);
    assert.ok(last.outreach_draft);
  });
});
