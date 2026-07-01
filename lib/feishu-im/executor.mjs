/**
 * FeishuIM — PolarUI 可复用功能块 executor
 *
 * params.bot_name 唯一必填；凭证从 PolarPrivate / env 解析
 */

import { loadBotConfig } from './config.mjs';
import { createFeishuClient, sendText, sendFile } from './client.mjs';
import { parseInboundPayload } from './route.mjs';

export async function executeFeishuIM(node, inputs) {
  const botName = String(node.params?.bot_name ?? 'PolarClaw_Rr');
  const action = String(node.params?.action ?? 'auto');
  const start = Date.now();

  const inbound = parseInboundPayload(inputs.webhook_payload ?? inputs);
  const cfg = await loadBotConfig(botName);
  const client = createFeishuClient(cfg);

  if (action === 'resolve' || (action === 'auto' && !inbound.openId)) {
    return {
      outputs: {
        bot_name: botName,
        slug: cfg.slug,
        source: cfg.source,
        status: 'resolved',
      },
      duration_ms: Date.now() - start,
    };
  }

  const receiveId = String(inputs.open_id ?? inputs.receive_id ?? inbound.openId);
  const text = String(inputs.text ?? inputs.message ?? inbound.message ?? '');
  const pdfPath = inputs.pdf_path ?? inputs.pdfPath ?? null;

  if (text) {
    await sendText(client, { receiveId, text });
  }

  if (pdfPath) {
    await sendFile(client, { receiveId, filePath: pdfPath });
  }

  return {
    outputs: {
      sent: true,
      bot_name: botName,
      receive_id: receiveId,
      text_sent: !!text,
      pdf_sent: !!pdfPath,
      status: 'ok',
    },
    duration_ms: Date.now() - start,
  };
}

export default executeFeishuIM;
