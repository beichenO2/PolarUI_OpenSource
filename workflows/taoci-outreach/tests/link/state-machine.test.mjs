import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setCompleteOverride, clearCompleteOverride } from '../../harness/lib/claude-core.mjs';
import { dispatch } from '../../harness/lib/state-machine.mjs';
import {
  mockStep0FirstTurn,
  mockStep0Ready,
  mockStep1Synthesize,
  mockStep2Draft,
  mockStep2Locked,
  mockStep3Prep,
  mockSubAgent,
  TEACHER,
  STUDENT_PROFILE,
} from '../mocks/llm-responses.mjs';

describe('taoci state machine (mock LLM)', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'taoci-test-'));
    process.env.TAOCI_SESSION_DIR = tmpDir;
    process.env.TAOCI_MOCK_PDF = '1';
  });

  after(async () => {
    clearCompleteOverride();
    delete process.env.TAOCI_SESSION_DIR;
    delete process.env.TAOCI_MOCK_PDF;
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearCompleteOverride();
  });

  it('S0 → S1 when teacher + student ready', async () => {
    const responses = [mockStep0FirstTurn(), mockStep0Ready()];
    setCompleteOverride(async () => responses.shift() ?? mockStep0Ready());

    const session = {
      step: 'S0_Clarify',
      teacher: { name: '', institution: '', url: '' },
      student: { profile: '', files: [] },
      research: null,
      selected_direction: null,
      outreach_draft: null,
      artifacts: {},
    };

    const r1 = await dispatch(session, '想套辞胡友财老师', '');
    assert.equal(session.step, 'S0_Clarify');
    assert.equal(r1.ready, false);

    const r2 = await dispatch(session, STUDENT_PROFILE, '');
    assert.equal(session.step, 'S1_Research');
    assert.equal(session.teacher.name, TEACHER.name);
    assert.match(r2.reply, /调研/);
  });

  it('S1 → S2 after research synthesize', async () => {
    const responses = [
      mockSubAgent(),
      mockSubAgent(),
      mockSubAgent(),
      mockStep1Synthesize(),
    ];
    setCompleteOverride(async () => responses.shift() ?? mockStep1Synthesize());

    const session = {
      step: 'S1_Research',
      teacher: TEACHER,
      student: { profile: STUDENT_PROFILE, files: [] },
      research: null,
      selected_direction: null,
      outreach_draft: null,
      artifacts: {},
    };

    const r = await dispatch(session, '继续', '');
    assert.equal(session.step, 'S2_Select');
    assert.ok(Array.isArray(r.direction_options));
  });

  it('S2 → S3 when direction locked', async () => {
    const responses = [mockStep2Draft(), mockStep2Locked()];
    setCompleteOverride(async () => responses.shift() ?? mockStep2Locked());

    const session = {
      step: 'S2_Select',
      teacher: TEACHER,
      student: { profile: STUDENT_PROFILE, files: [] },
      research: { reputation: {}, authorship: {}, directions: {} },
      selected_direction: null,
      outreach_draft: null,
      artifacts: {},
    };

    await dispatch(session, '看看话术', '');
    const r = await dispatch(session, '确认方向 A', '');
    assert.equal(session.step, 'S3_DeepPrep');
    assert.ok(session.outreach_draft);
    assert.ok(r.pdf_path);
  });

  it('S3 produces mock_qa ≥10 with required questions', async () => {
    setCompleteOverride(async () => mockStep3Prep());

    const session = {
      step: 'S3_DeepPrep',
      teacher: TEACHER,
      student: { profile: STUDENT_PROFILE, files: [] },
      research: {},
      selected_direction: { title: '托酚酮杂萜' },
      outreach_draft: '胡老师您好…',
      artifacts: {},
    };

    const r = await dispatch(session, '生成深度准备', '');
    assert.ok(Array.isArray(r.mock_qa));
    assert.ok(r.mock_qa.length >= 10);
    const qs = r.mock_qa.map((x) => x.q).join('\n');
    assert.match(qs, /为什么.*细分领域/);
    assert.match(qs, /胜任/);
    assert.ok(r.pdf_path);
  });
});
