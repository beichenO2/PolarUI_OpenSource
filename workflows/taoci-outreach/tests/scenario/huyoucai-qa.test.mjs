import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEACHER, STUDENT_PROFILE } from '../mocks/llm-responses.mjs';

const HARNESS = join(
  fileURLToPath(new URL('../../harness/index.mjs', import.meta.url)),
);

function runHarness(conversationId, message, sessionDir) {
  const r = spawnSync(
    'node',
    [HARNESS, '--conversation-id', conversationId, '--message', message],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TAOCI_USE_CLAUDE_CLI: '0',
        TAOCI_SESSION_DIR: sessionDir,
        TAOCI_MOCK_PDF: '1',
        TAOCI_MOCK_LLM: '1',
      },
    },
  );
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line ?? '{}');
}

describe('scenario QA: 胡友财套辞（郭韵怡）', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'taoci-scenario-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('full multi-turn conversation reaches done with PDF + QA', () => {
    const conv = 'qa-huyoucai-001';
    const turns = [
      '@套辞 想套辞胡友财老师，药大制药工程大三',
      STUDENT_PROFILE,
      '继续调研',
      '看看套辞话术',
      '确认方向 A',
      '生成深度准备材料',
    ];

    let last;
    for (const msg of turns) {
      last = runHarness(conv, msg, tmpDir);
      assert.equal(last.ok, true, `turn failed: ${msg} → ${JSON.stringify(last)}`);
    }

    assert.equal(last.step, 'done');
    assert.equal(last.session_snapshot.teacher.name, TEACHER.name);
    assert.ok(last.session_snapshot.selected_direction);
    assert.ok(Array.isArray(last.mock_qa));
    assert.ok(last.mock_qa.length >= 10);
    assert.ok(last.pdf_path);
    assert.ok(last.outreach_draft);
  });
});
