/**
 * PolarPrivate 4-bit QCSA 模型码解析（SSoT）
 * 对齐 PolarPrivate/backend/app/core/model_routing.py CAPABILITY_CLOUD_MAP
 */

/** 友好名 → 4-bit QCSA */
export const MODEL_ALIAS_TO_QCSA = {
  'GLM-5.1': '0000',
  'GLM-5': '1000',
  'GLM-5-TURBO': '0010',
  'GLM-TURBO': '0010',
  'ASTRON-CODE-LATEST': '0001',
  'CLAUDE-SONNET': '1000',
  'CLAUDE-3-SONNET': '1000',
  'CLAUDE-3-5-SONNET': '1000',
  'QWEN-PLUS': '1100',
  'QWEN-MAX': '1100',
  'DS-V4-FLASH': '0010',
  'DS-V4-PRO': '0100',
  'MINIMAX-M3': '0110',
  'QWEN3.7-PLUS': '1100',
};

/** 旧 3-bit → 4-bit（向后兼容） */
export const LEGACY_3BIT_TO_4BIT = {
  '000': '0000',
  '001': '0010',
  '010': '0100',
  '011': '0110',
  '100': '0000',
  '101': '0101',
  '110': '1100',
  '111': '1110',
};

const LOCAL_CODES = new Set(['L0000', 'L0001']);
const LOCAL_L4_RE = /^L[01]{4}$/i;
const VISION_RE = /^V[01]{4}$/i;
const CLOUD_4BIT_RE = /^[01]{4}$/;

/**
 * @param {string} model
 * @param {'cloud'|'local'} [tier]
 */
export function resolveModelCode(model, tier = 'cloud') {
  const raw = String(model ?? '').trim();
  if (!raw) throw new Error('model is required');

  const alias = MODEL_ALIAS_TO_QCSA[raw.toUpperCase()] ?? raw;
  const upper = alias.toUpperCase();

  if (LOCAL_CODES.has(upper) || LOCAL_L4_RE.test(alias)) return upper;
  if (upper === 'E000') return 'E000';
  if (VISION_RE.test(alias)) return alias.toUpperCase();

  if (CLOUD_4BIT_RE.test(alias)) {
    return tier === 'local' ? `L${alias}` : alias;
  }

  if (/^[01]{3}$/.test(alias)) {
    const mapped = LEGACY_3BIT_TO_4BIT[alias];
    if (mapped) return tier === 'local' ? `L${mapped}` : mapped;
  }

  throw new Error(
    `Unknown model code "${raw}". Cloud: 0000–1111, V0000–V1111. Local: L0000/L0001. Embed: E000.`,
  );
}

/** 上游 429/502 时的 fallback 链 */
export function fallbackModelChain(code) {
  const c = String(code);
  if (c === '1000' || c === '1100' || c === '1110' || c === '1001' || c === '1101') {
    return [c, '0000', '0010'];
  }
  if (c === '0001' || c === '0011' || c === '0101' || c === '1011' || c === '1101') {
    return [c, '0000', '0010'];
  }
  return [c];
}

/** 供 patch-llm-proxy-qcsa.mjs 写入 bundle 的 minified 片段 */
export function bundleFragments() {
  const tcn = Object.entries(MODEL_ALIAS_TO_QCSA)
    .map(([k, v]) => `"${k}":"${v}"`)
    .join(',');

  const v5t = 'function v5t(l,f="cloud"){const d=(l??"").trim(),raw=(tcn[d.toUpperCase()]??d),u=raw.toUpperCase();if(u==="L0000"||u==="L0001"||/^L[01]{4}$/i.test(raw))return u;if(u==="E000")return"E000";if(/^V[01]{4}$/i.test(raw))return raw.toUpperCase();if(/^[01]{4}$/.test(raw))return f==="local"?"L"+raw:raw;if(/^[01]{3}$/.test(raw)){const m={"000":"0000","001":"0010","010":"0100","011":"0110","100":"0000","101":"0101","110":"1100","111":"1110"}[raw];if(m)return f==="local"?"L"+m:m}throw new Error(`Unknown model code "${raw}". Cloud: 0000–1111, V0000–V1111. Local: L0000/L0001. Embed: E000.`)}';

  const icn = 'const rcn=["0010","0000"];function icn(l){return l==="1000"||l==="1100"||l==="1110"||l==="1001"||l==="1101"?[l,...rcn]:l==="0001"||l==="0011"||l==="0101"||l==="1011"?[l,"0000","0010"]:[l]}';

  return { tcn: `tcn={${tcn}}`, v5t, icn };
}
