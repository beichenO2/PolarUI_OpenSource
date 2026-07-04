#!/usr/bin/env node
/**
 * PolarClaw → 套辞 Harness 桥接
 * @套辞 路由 → PolarUI graph engine（executeGraph）
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  isTaociTrigger,
  stripTaociTrigger,
  buildConversationId,
} from '../../../lib/feishu-im/route.mjs';
import { loadBotConfig } from '../../../lib/feishu-im/config.mjs';
import { createFeishuClient, sendText, sendFile } from '../../../lib/feishu-im/client.mjs';
import { runWorkflowGraph } from '../../../lib/run-graph.mjs';

const WORKFLOW_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BOT = 'PolarClaw_Rr';
const WORKFLOW_ID = 'taoci-outreach';

export { isTaociTrigger, stripTaociTrigger, buildConversationId };

/** @deprecated 使用 runTaociGraph */
export async function runTaociHarness(params) {
  return runTaociGraph(params);
}

/** 经 graph engine 执行 taoci-outreach.lg.json */
export async function runTaociGraph({ conversationId, message, files = [] }) {
  const result = await runWorkflowGraph({
    workflowId: WORKFLOW_ID,
    inputs: { conversationId, message, files },
  });
  return normalizeGraphResult(result);
}

function normalizeGraphResult(result) {
  let parsed = null;
  for (const nodeResult of Object.values(result.outputs ?? {})) {
    const outs = nodeResult?.outputs ?? {};
    for (const val of [outs.content, outs.stdout, outs.result]) {
      if (typeof val !== 'string') continue;
      try {
        const j = JSON.parse(val);
        if (j && (j.reply != null || j.ok != null || j.step != null)) parsed = j;
      } catch {
        /* skip */
      }
    }
  }

  if (parsed) {
    return {
      ok: parsed.ok ?? result.ok,
      reply: parsed.reply ?? parsed.error,
      step: parsed.step,
      pdf_path: parsed.pdf_path ?? null,
      engine: 'graph',
      node_traces: result.node_traces,
      ...parsed,
    };
  }

  return {
    ok: result.ok,
    reply: typeof result.merged_output === 'string' ? result.merged_output : JSON.stringify(result.merged_output ?? ''),
    engine: 'graph',
    node_traces: result.node_traces,
  };
}

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

  return {
    routed: true,
    conversationId,
    message,
    files,
    botName,
  };
}

export async function runTaociHarnessSync(params) {
  return runTaociGraph(params);
}

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

export async function routeAndReply(inbound) {
  const handled = handleTaociInbound(inbound);
  if (!handled.routed) return handled;

  const result = await runTaociGraph({
    conversationId: handled.conversationId,
    message: handled.message,
    files: handled.files ?? [],
  });
  const reply = result.reply ?? result.error ?? '处理完成';

  await sendFeishuReply({
    openId: inbound.openId,
    text: reply,
    pdfPath: result.pdf_path ?? null,
    botName: inbound.botName ?? DEFAULT_BOT,
  });

  return { ...handled, result, reply, pdfPath: result.pdf_path ?? null, sent: true };
}
