#!/usr/bin/env node
/**
 * PolarUI headless chat — PolarClaw /api/workflow/chat 调用
 * taoci-outreach workflow 走 harness 直连
 */
import { runTaociHarness } from '../workflows/taoci-outreach/feishu/bridge.mjs';

function parseArgs(argv) {
  const out = { workflow: '', conversationId: '', message: '', userId: '' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--workflow') out.workflow = argv[++i];
    else if (argv[i] === '--conversation-id') out.conversationId = argv[++i];
    else if (argv[i] === '--message') out.message = argv[++i];
    else if (argv[i] === '--user-id') out.userId = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);

if (!args.workflow || !args.conversationId || !args.message) {
  console.error(JSON.stringify({ error: 'missing --workflow --conversation-id --message' }));
  process.exit(1);
}

const result = runTaociHarness({
  conversationId: args.conversationId,
  message: args.message,
  files: [],
});

console.log(JSON.stringify({
  content: result.reply,
  step: result.step,
  pdf_path: result.pdf_path,
  ...result,
}));
