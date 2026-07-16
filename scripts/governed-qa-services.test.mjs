import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGovernedServiceRegistration,
  registerAndStartGovernedService,
  runGovernedServiceAction,
} from './governed-qa-services.mjs';

test('builds a foreground PolarProcess registration without detached lifecycle flags', () => {
  const registration = buildGovernedServiceRegistration({
    id: 'native-web-qa-runtime-1',
    name: 'Native Web QA Runtime',
    command: "bash scripts/start-native-web-qa-runtime.sh '/tmp/runtime.env'",
    workDir: '/tmp/PolarUI',
    port: 13925,
    healthUrl: 'http://127.0.0.1:13925/health',
  });
  assert.equal(registration.id, 'native-web-qa-runtime-1');
  assert.equal(registration.port, 13925);
  assert.equal(registration.restart_on_failure, true);
  assert.equal(registration.start_script_dir, '-');
  assert.doesNotMatch(registration.command, /(?:nohup|\s&\s*$|\s-d(?:\s|$)|--detach)/);
});

test('registers, starts, and restarts only through PolarProcess APIs', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const registration = buildGovernedServiceRegistration({
    id: 'native-web-qa-runtime-1', name: 'Runtime', command: 'bash Start/runtime.sh',
    workDir: '/tmp/PolarUI', port: 13925, healthUrl: 'http://127.0.0.1:13925/health',
  });
  await registerAndStartGovernedService(registration, { fetch: fetchImpl, baseUrl: 'http://process.test' });
  await runGovernedServiceAction(registration.id, 'restart', { fetch: fetchImpl, baseUrl: 'http://process.test' });
  assert.equal(calls[0].url, 'http://process.test/api/services/register-and-start');
  assert.equal(JSON.parse(calls[0].init.body).id, registration.id);
  assert.equal(calls[1].url, 'http://process.test/api/services/native-web-qa-runtime-1/restart');
});
