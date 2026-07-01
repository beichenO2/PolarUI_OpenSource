#!/usr/bin/env node
/**
 * 套辞 Workflow Harness — 状态机入口
 * PolarUI / PolarClaw 飞书 通过 ShellExec 或 HTTP 调用
 *
 * Usage:
 *   node harness/index.mjs --conversation-id ID --message "..." [--files a.pdf,b.doc]
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { loadSession, saveSession, appendHistory } from './lib/session-store.mjs';
import { dispatch } from './lib/state-machine.mjs';
import { setActiveSession } from './lib/claude-core.mjs';

function parseArgs(argv) {
  const out = { conversationId: 'default', message: '', files: [] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--conversation-id') out.conversationId = argv[++i];
    else if (argv[i] === '--message') out.message = argv[++i] ?? '';
    else if (argv[i] === '--files') {
      out.files = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

async function extractFileTexts(paths) {
  const parts = [];
  for (const p of paths) {
    try {
      const ext = extname(p).toLowerCase();
      if (['.txt', '.md', '.tex'].includes(ext)) {
        parts.push(`--- ${p} ---\n${await readFile(p, 'utf8')}`);
      } else if (ext === '.pdf') {
        parts.push(`--- ${p} ---\n[PDF 附件，路径: ${p}，请结合用户文字理解]`);
      } else {
        parts.push(`--- ${p} ---\n[二进制/Office 文件: ${p}]`);
      }
    } catch (e) {
      parts.push(`--- ${p} ---\n[读取失败: ${e.message}]`);
    }
  }
  return parts.join('\n\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const session = await loadSession(args.conversationId);

  if (args.files.length) {
    session.student.files = [...new Set([...(session.student.files ?? []), ...args.files])];
  }

  appendHistory(session, 'user', args.message);
  setActiveSession(session);
  const fileTexts = await extractFileTexts(args.files);

  let result;
  try {
    result = await dispatch(session, args.message, fileTexts);
  } catch (err) {
    result = {
      reply: `处理出错: ${err instanceof Error ? err.message : String(err)}`,
      step: session.step,
      error: true,
    };
  }

  appendHistory(session, 'assistant', result.reply);
  setActiveSession(session);
  await saveSession(args.conversationId, session);

  const output = {
    ok: !result.error,
    conversation_id: args.conversationId,
    step: session.step,
    reply: result.reply,
    pdf_path: result.pdf_path ?? null,
    outreach_draft: result.outreach_draft ?? session.outreach_draft,
    direction_options: result.direction_options ?? null,
    mock_qa: result.mock_qa ?? null,
    session_snapshot: {
      teacher: session.teacher,
      selected_direction: session.selected_direction,
      artifacts: session.artifacts,
    },
  };

  console.log(JSON.stringify(output));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
