/**
 * @套辞 路由 — PolarClaw 飞书入口
 */

const TAOCI_PATTERN = /@套辞/;

export function isTaociTrigger(text) {
  return TAOCI_PATTERN.test(String(text ?? ''));
}

export function stripTaociTrigger(text) {
  return String(text ?? '')
    .replace(TAOCI_PATTERN, '')
    .trim();
}

export function buildConversationId(channel, userId) {
  const raw = `${channel}:${userId}`;
  const safe = raw.replace(/[^a-zA-Z0-9:_-]/g, '_');
  return `taoci-${safe}`;
}

/** 解析飞书 webhook / PolarClaw inbound 为 harness 入参 */
export function parseInboundPayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const text = String(p.text ?? p.message ?? p.content ?? '');
  const openId = String(p.open_id ?? p.openId ?? p.userId ?? p.user_id ?? 'unknown');
  const channel = String(p.channel ?? 'feishu');
  const files = Array.isArray(p.files) ? p.files : [];
  return {
    text,
    openId,
    channel,
    files,
    isTaoci: isTaociTrigger(text),
    message: stripTaociTrigger(text) || text,
    conversationId: buildConversationId(channel, openId),
  };
}
