#!/usr/bin/env node
/**
 * PolarClaw → 套辞 Harness 桥接
 * @套辞 路由 + FeishuIM 回传
 */
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import {
  isTaociTrigger,
  stripTaociTrigger,
  buildConversationId,
} from '../../../lib/feishu-im/route.mjs';
import { loadBotConfig } from '../../../lib/feishu-im/config.mjs';
import { createFeishuClient, sendText, sendFile } from '../../../lib/feishu-im/client.mjs';

const WORKFLOW_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLARUI_ROOT = join(WORKFLOW_ROOT, '..', '..');
const HARNESS = join(WORKFLOW_ROOT, 'harness', 'index.mjs');
const DEFAULT_BOT = 'PolarClaw_Rr';

export { isTaociTrigger, stripTaociTrigger, buildConversationId };

export function runTaociHarness({ conversationId, message, files = [] }) {
  const args = [
    HARNESS,
    '--conversation-id', conversationId,
    '--message', message,
  ];
  if (files.length) args.push('--files', files.join(','));

  const r = spawnSync('node', args, {
    cwd: POLARUI_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, TAOCI_USE_CLAUDE_CLI: '0' },
  });

  const stdout = (r.stdout || '').trim();
  const lastLine = stdout.split('\n').filter(Boolean).pop() ?? stdout;
  try {
    return JSON.parse(lastLine);
  } catch {
    return { ok: false, error: r.stderr || stdout || 'harness parse error' };
  }
}

/** 处理 @套辞 入站消息 */
export function handleTaociInbound({
  channel = 'feishu:rr',
  openId,
  text,
  files = [],
  botName = DEFAULT_BOT,
}) {
  if (!isTaociTrigger(text)) {
    return { routed: false };
  }

  const conversationId = buildConversationId(channel, openId);
  const message = stripTaociTrigger(text);
  const result = runTaociHarness({ conversationId, message, files });

  return {
    routed: true,
    conversationId,
    result,
    reply: result.reply ?? result.error ?? '处理完成',
    pdfPath: result.pdf_path ?? null,
    botName,
  };
}

/** 发送 PDF 回飞书 */
export async function sendFeishuReply({
  openId,
  text,
  pdfPath,
  botName = DEFAULT_BOT,
  feishuClient,
}) {
  let client = feishuClient;
  if (!client) {
    const cfg = await loadBotConfig(botName);
    client = createFeishuClient(cfg);
  }

  if (text) {
    await sendText(client, { receiveId: openId, text });
  }

  if (pdfPath && existsSync(pdfPath)) {
    await sendFile(client, { receiveId: openId, filePath: pdfPath });
    return { sent: true, pdf_path: pdfPath };
  }

  return { sent: true };
}

/** 完整 @套辞 链路：harness + 回传 */
export async function routeAndReply(inbound) {
  const handled = handleTaociInbound(inbound);
  if (!handled.routed) return handled;

  await sendFeishuReply({
    openId: inbound.openId,
    text: handled.reply,
    pdfPath: handled.pdfPath,
    botName: inbound.botName ?? DEFAULT_BOT,
  });

  return { ...handled, sent: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const body = JSON.parse(readFileSync(0, 'utf8'));
  const result = await routeAndReply(body);
  console.log(JSON.stringify(result));
}
