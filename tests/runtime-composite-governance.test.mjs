import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => {
  const url = new URL(path, root);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
};
const polaris = JSON.parse(read('polaris.json'));
const services = polaris.service_management?.services ?? [];

test('Mailpit owns its SMTP secondary listener in multi-service SSoT', () => {
  const mailpit = services.find(({ service_id: id }) => id === 'polarui-native-web-qa-mailpit');
  assert.equal(mailpit?.preferred_port, 14940);
  assert.deepEqual(mailpit?.port_bindings, [
    { service_name: 'polarui-native-web-qa-smtp', project: 'PolarUI', port: 14945 },
  ]);
});

test('brainstorm service has a governed foreground launcher contract', () => {
  const brainstorm = services.find(({ service_id: id }) => id === 'polarui-brainstorm-ui-logic');
  assert.equal(brainstorm?.start_command, 'bash Start/brainstorm-ui-logic.sh');
  assert.equal(brainstorm?.preferred_port, 14950);
  assert.equal(brainstorm?.auto_start, false);

  const launcher = read('Start/brainstorm-ui-logic.sh');
  assert.match(launcher, /POLARPORT_URL=.*127\.0\.0\.1:11050/);
  assert.match(launcher, /curl[^\n]*\$POLARPORT_URL\/api\/health/);
  assert.match(launcher, /POLARPROCESS_URL=.*127\.0\.0\.1:11055/);
  assert.match(launcher, /curl[^\n]*\$POLARPROCESS_URL\/api\/health/);
  assert.match(launcher, /claim_port "polarui-brainstorm-ui-logic" "PolarUI" 14950/);
  assert.match(launcher, /BRAINSTORM_SERVER=.*server\.cjs/);
  assert.match(launcher, /exec "\$NODE_BINARY" "\$BRAINSTORM_SERVER"/);
  assert.doesNotMatch(launcher, /(?:nohup|disown|pkill|killall|PID_FILE|[^&]&\s*$)/m);
});

test('brainstorm registration is inspectable and does not mutate lifecycle', () => {
  const register = read('Start/register-brainstorm-ui-logic.sh');
  assert.match(register, /api\/services\/register/);
  assert.match(register, /"id":"polarui-brainstorm-ui-logic"/);
  assert.match(register, /"command":"bash Start\/brainstorm-ui-logic\.sh"/);
  assert.match(register, /"port":14950/);
  assert.doesNotMatch(register, /api\/services\/polarui-brainstorm-ui-logic\/(?:start|stop|restart)/);
});
