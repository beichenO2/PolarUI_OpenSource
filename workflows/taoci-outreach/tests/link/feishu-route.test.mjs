import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTaociTrigger,
  stripTaociTrigger,
  buildConversationId,
} from '../../../../lib/feishu-im/route.mjs';

describe('Feishu @套辞 routing', () => {
  it('detects @套辞 trigger', () => {
    assert.equal(isTaociTrigger('@套辞 想套辞胡友财老师'), true);
    assert.equal(isTaociTrigger('  @套辞  '), true);
    assert.equal(isTaociTrigger('普通聊天'), false);
  });

  it('strips trigger prefix from message', () => {
    assert.equal(
      stripTaociTrigger('@套辞 药大大三，想联系胡友财'),
      '药大大三，想联系胡友财',
    );
  });

  it('buildConversationId is stable per channel+user', () => {
    const a = buildConversationId('feishu:rr', 'ou_abc');
    const b = buildConversationId('feishu:rr', 'ou_abc');
    assert.equal(a, b);
    assert.match(a, /^taoci-/);
  });
});
