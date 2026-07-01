import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  botNameToSlug,
  secretKeysForBot,
  envPrefixForBot,
  loadBotConfig,
} from '../../../../lib/feishu-im/config.mjs';

describe('FeishuIM config', () => {
  it('botNameToSlug maps PolarClaw_Rr → rr', () => {
    assert.equal(botNameToSlug('PolarClaw_Rr'), 'rr');
  });

  it('secretKeysForBot uses feishu.rr.* PolarPrivate convention', () => {
    const keys = secretKeysForBot('rr');
    assert.equal(keys.app_id, 'feishu.rr.app_id');
    assert.equal(keys.app_secret, 'feishu.rr.app_secret');
    assert.equal(keys.verification_token, 'feishu.rr.verification_token');
    assert.equal(keys.encrypt_key, 'feishu.rr.encrypt_key');
  });

  it('envPrefixForBot → FEISHU_RR', () => {
    assert.equal(envPrefixForBot('rr'), 'FEISHU_RR');
  });

  it('loadBotConfig reads env when FEISHU_RR_* set', async () => {
    const prev = {
      id: process.env.FEISHU_RR_APP_ID,
      secret: process.env.FEISHU_RR_APP_SECRET,
      token: process.env.FEISHU_RR_VERIFICATION_TOKEN,
    };
    process.env.FEISHU_RR_APP_ID = 'cli_test_id';
    process.env.FEISHU_RR_APP_SECRET = 'cli_test_secret';
    process.env.FEISHU_RR_VERIFICATION_TOKEN = 'cli_test_token';
    try {
      const cfg = await loadBotConfig('PolarClaw_Rr');
      assert.equal(cfg.appId, 'cli_test_id');
      assert.equal(cfg.slug, 'rr');
      assert.equal(cfg.source, 'env');
    } finally {
      if (prev.id === undefined) delete process.env.FEISHU_RR_APP_ID;
      else process.env.FEISHU_RR_APP_ID = prev.id;
      if (prev.secret === undefined) delete process.env.FEISHU_RR_APP_SECRET;
      else process.env.FEISHU_RR_APP_SECRET = prev.secret;
      if (prev.token === undefined) delete process.env.FEISHU_RR_VERIFICATION_TOKEN;
      else process.env.FEISHU_RR_VERIFICATION_TOKEN = prev.token;
    }
  });
});
