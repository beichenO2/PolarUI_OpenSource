/**
 * Feishu IM 客户端 — 文本 / 文件回传
 */

import * as Lark from '@larksuiteoapi/node-sdk';

export function createFeishuClient(config) {
  const domain = config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
  return new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain,
  });
}

export async function sendText(client, { receiveId, receiveIdType = 'open_id', text }) {
  return client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
}

export async function sendFile(client, { receiveId, receiveIdType = 'open_id', filePath, fileName }) {
  const { createReadStream } = await import('node:fs');
  const { basename } = await import('node:path');
  const name = fileName ?? basename(filePath);

  const upload = await client.im.file.create({
    data: {
      file_type: 'stream',
      file_name: name,
      file: createReadStream(filePath),
    },
  });

  const fileKey = upload?.file_key ?? upload?.data?.file_key;
  if (!fileKey) throw new Error('im.file.create returned no file_key');

  return client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
  });
}

export async function replyToMessage(client, { messageId, text, pdfPath }) {
  await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });

  if (pdfPath) {
    // 飞书 reply 不支持附件，需单独发 file 消息给 open_id（由调用方提供 receiveId）
    return { replied: true, pdfPath, note: 'PDF requires separate sendFile with open_id' };
  }
  return { replied: true };
}
