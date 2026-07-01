/**
 * FeishuIM — PolarPrivate 凭证解析
 *
 * Bot 名 → slug → PolarPrivate key 前缀：
 *   PolarClaw_Rr → feishu.rr.*
 *   环境变量：FEISHU_RR_*（PolarClaw 启动时注入）
 */

const DEFAULT_PP_URL = process.env.POLARPRIVATE_URL ?? 'http://127.0.0.1:12790';

const BOT_SLUG_ALIASES = {
  polarclaw_rr: 'rr',
  rr: 'rr',
};

/** PolarClaw_Rr → rr */
export function botNameToSlug(botName) {
  const raw = botName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return BOT_SLUG_ALIASES[raw] ?? raw;
}

/** PolarPrivate Secret key 命名（与 setup-polarprivate.sh 一致） */
export function secretKeysForBot(slug) {
  return {
    app_id: `feishu.${slug}.app_id`,
    app_secret: `feishu.${slug}.app_secret`,
    verification_token: `feishu.${slug}.verification_token`,
    encrypt_key: `feishu.${slug}.encrypt_key`,
  };
}

/** PolarPrivate Identity key */
export function identityKeysForBot(slug) {
  return {
    app_name: `feishu.${slug}.app_name`,
    webhook_path: `feishu.${slug}.webhook_path`,
  };
}

export function envPrefixForBot(slug) {
  return `FEISHU_${slug.toUpperCase()}`;
}

function loadFromEnv(prefix, env = process.env) {
  const p = prefix.toUpperCase();
  const appId = (env[`${p}_APP_ID`] ?? '').trim();
  const appSecret = (env[`${p}_APP_SECRET`] ?? '').trim();
  const verificationToken = (env[`${p}_VERIFICATION_TOKEN`] ?? '').trim();
  const encryptKey = (env[`${p}_ENCRYPT_KEY`] ?? '').trim();
  if (!appId || !appSecret || !verificationToken) return null;
  return {
    appId,
    appSecret,
    encryptKey,
    verificationToken,
    domain: (env.FEISHU_DOMAIN ?? 'feishu').trim().toLowerCase() === 'lark' ? 'lark' : 'feishu',
  };
}

async function fetchIdentities(baseUrl, timeoutMs = 5000) {
  const res = await fetch(`${baseUrl}/api/identities?limit=200`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.items ?? [];
}

async function grantSecrets(baseUrl, serviceName, slug, timeoutMs = 5000) {
  const sha256 = process.env.DCLASS_CALLER_SHA256?.trim();
  if (!sha256) return null;
  const keys = secretKeysForBot(slug);
  const res = await fetch(`${baseUrl}/api/d-class/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      service_name: serviceName,
      caller_executable_sha256: sha256,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const secrets = data.secrets ?? {};
  const appId = secrets[keys.app_id];
  const appSecret = secrets[keys.app_secret];
  const verificationToken = secrets[keys.verification_token];
  if (!appId || !appSecret || !verificationToken) return null;
  return {
    appId,
    appSecret,
    verificationToken,
    encryptKey: secrets[keys.encrypt_key] ?? '',
    domain: 'feishu',
  };
}

/**
 * 加载 Bot 配置 — 仅需 bot 名
 * 优先级：process.env → PolarPrivate d-class grant
 */
export async function loadBotConfig(botName, options = {}) {
  const slug = botNameToSlug(botName);
  const prefix = envPrefixForBot(slug);
  const polarPrivateUrl = options.polarPrivateUrl ?? DEFAULT_PP_URL;

  const fromEnv = loadFromEnv(prefix, options.env ?? process.env);
  if (fromEnv) {
    return { ...fromEnv, botName, slug, prefix, source: 'env' };
  }

  const identities = await fetchIdentities(polarPrivateUrl, options.timeoutMs);
  const idKeys = identityKeysForBot(slug);
  const appNameIdentity = identities.find((i) => i.key === idKeys.app_name);
  if (appNameIdentity && appNameIdentity.value !== botName) {
    throw new Error(
      `Feishu bot identity mismatch: ${idKeys.app_name}=${appNameIdentity.value}, expected ${botName}`,
    );
  }

  const serviceName = `feishu-${slug}`;
  const fromGrant = await grantSecrets(polarPrivateUrl, serviceName, slug, options.timeoutMs);
  if (fromGrant) {
    return { ...fromGrant, botName, slug, prefix, source: 'd-class' };
  }

  const keys = secretKeysForBot(slug);
  throw new Error(
    `Feishu bot "${botName}" 未配置。请在 PolarPrivate 填写 ${keys.app_id} 等 Secret，` +
    `或设置 ${prefix}_APP_ID / _APP_SECRET / _VERIFICATION_TOKEN`,
  );
}

export function describeBotStorage(botName) {
  const slug = botNameToSlug(botName);
  return {
    botName,
    slug,
    envPrefix: envPrefixForBot(slug),
    secretKeys: secretKeysForBot(slug),
    identityKeys: identityKeysForBot(slug),
  };
}
