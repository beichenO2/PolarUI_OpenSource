import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { STUDENT_PROFILE, TEACHER } from '../mocks/llm-responses.mjs';

describe('taoci state machine (graph engine)', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'taoci-sm-'));
    process.env.TAOCI_USE_CLAUDE_CLI = '0';
    process.env.TAOCI_MOCK_LLM = '1';
    process.env.TAOCI_MOCK_PDF = '1';
    process.env.TAOCI_SESSION_DIR = tmpDir;
    delete process.env.POLARUI_MOCK_LLM;
    delete process.env.POLARUI_MOCK_TOOLCALL;
    const { resetHeadlessEngine } = await import('../../../../lib/headless-engine.mjs');
    const { resetMockRegistration } = await import('../../../../lib/test-mocks/register.mjs');
    const { resetTaociRegistration } = await import('../../../../lib/taoci-graph/register.mjs');
    const { resetMemoryRegistration } = await import('../../../../lib/memory-graph/register.mjs');
    resetHeadlessEngine();
    resetMockRegistration();
    resetTaociRegistration();
    resetMemoryRegistration();
  });

  after(async () => {
    delete process.env.TAOCI_USE_CLAUDE_CLI;
    delete process.env.TAOCI_MOCK_LLM;
    delete process.env.TAOCI_MOCK_PDF;
    delete process.env.TAOCI_SESSION_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function runTurn(conv, message) {
    const { runWorkflowGraph } = await import('../../../../lib/run-graph.mjs');
    const result = await runWorkflowGraph({
      workflowId: 'taoci-outreach',
      inputs: { conversationId: conv, message },
    });
    const sess = JSON.parse(await readFile(join(tmpDir, `${conv}.json`), 'utf8'));
    return { result, session: sess };
  }

  it('S0 首轮：缺信息，留在 S0_Clarify', async () => {
    const conv = `sm-s0-${Date.now()}`;
    const { result, session } = await runTurn(conv, '想套辞一位老师');
    assert.ok(result.ok);
    assert.equal(session.step, 'S0_Clarify');
    assert.ok(result.node_traces.includes('ScenarioMemoryLoad'));
    assert.ok(result.node_traces.includes('Switch'));
    assert.ok(result.node_traces.includes('LLM'));
    assert.ok(result.node_traces.includes('ScenarioMemorySave'));
    assert.ok(!result.node_traces.includes('TaociSubAgent'));
  });

  it('S0 → S1：补齐 teacher + profile', async () => {
    const conv = `sm-s0s1-${Date.now()}`;
    await runTurn(conv, '想套辞胡友财老师，协和药物所');
    const { session } = await runTurn(conv, STUDENT_PROFILE);
    assert.equal(session.step, 'S1_Research');
    assert.equal(session.teacher.name, TEACHER.name);
    assert.ok(session.student.profile.includes('郭韵怡'));
  });

  it('S1 → S2：调研完成', async () => {
    const conv = `sm-s1s2-${Date.now()}`;
    await runTurn(conv, '想套辞胡友财老师，药大制药工程大三');
    await runTurn(conv, STUDENT_PROFILE);
    const { result, session } = await runTurn(conv, '继续调研');
    assert.ok(result.ok);
    assert.equal(session.step, 'S2_Select');
    assert.ok(result.node_traces.includes('TaociSubAgent'));
  });

  it('S2 → S3 → done：确认方向并生成深度材料', async () => {
    const conv = `sm-s2done-${Date.now()}`;
    await runTurn(conv, '想套辞胡友财老师，药大制药工程大三');
    await runTurn(conv, STUDENT_PROFILE);
    await runTurn(conv, '继续调研');
    await runTurn(conv, '看看套辞话术');
    await runTurn(conv, '确认方向 A');
    const { session } = await runTurn(conv, '生成深度准备材料');
    assert.equal(session.step, 'done');
    assert.ok(session.artifacts.prep_pdf || session.artifacts.overview_pdf);
  });
});
