import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGovernedServiceRegistration,
  registerAndStartGovernedService,
  releaseGovernedQaPort,
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

test('preflights an owner-matched PolarPort claim before release and preserves port-only compatibility', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (String(url).endsWith('/api/list?all=true')) {
      return new Response(JSON.stringify([{
        port: 14935,
        service_name: 'web-native-web-qa',
        project: 'PolarUI',
        status: 'active',
      }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await releaseGovernedQaPort(14935, {
    serviceName: 'web-native-web-qa',
    project: 'PolarUI',
    fetch: fetchImpl,
    baseUrl: 'http://port.test',
  });
  await releaseGovernedQaPort(14940, { fetch: fetchImpl, baseUrl: 'http://port.test' });

  assert.deepEqual(calls, [
    {
      url: 'http://port.test/api/list?all=true',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://port.test/api/release',
      method: 'POST',
      body: { port: 14935, service_name: 'web-native-web-qa', project: 'PolarUI' },
    },
    {
      url: 'http://port.test/api/release',
      method: 'POST',
      body: { port: 14940 },
    },
  ]);
});

test('rejects an owner mismatch without posting a PolarPort release', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method });
    return new Response(JSON.stringify([{
      port: 14935,
      service_name: 'another-service',
      project: 'AnotherProject',
      status: 'active',
    }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await assert.rejects(releaseGovernedQaPort(14935, {
    serviceName: 'web-native-web-qa',
    project: 'PolarUI',
    fetch: fetchImpl,
    baseUrl: 'http://port.test',
  }), /owned by another-service\/AnotherProject, not web-native-web-qa\/PolarUI/);

  assert.deepEqual(calls, [{ url: 'http://port.test/api/list?all=true', method: 'GET' }]);
});

test('rejects missing or duplicate active PolarPort rows without posting a release', async (t) => {
  for (const [name, rows, expectedCount] of [
    ['missing', [], 0],
    ['duplicate', [
      { port: 14935, service_name: 'web-native-web-qa', project: 'PolarUI', status: 'active' },
      { port: 14935, service_name: 'web-native-web-qa', project: 'PolarUI', status: 'active' },
    ], 2],
  ]) {
    await t.test(name, async () => {
      const calls = [];
      const fetchImpl = async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method });
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      await assert.rejects(releaseGovernedQaPort(14935, {
        serviceName: 'web-native-web-qa',
        project: 'PolarUI',
        fetch: fetchImpl,
        baseUrl: 'http://port.test',
      }), new RegExp(`expected exactly one active row for port 14935, found ${expectedCount}`));

      assert.deepEqual(calls, [{ url: 'http://port.test/api/list?all=true', method: 'GET' }]);
    });
  }
});

test('restarts a governed service in stop, claim exact preferred port, start order', async () => {
  const services = await import('./governed-qa-services.mjs');
  assert.equal(typeof services.restartGovernedServiceWithPort, 'function');
  const calls = [];

  await services.restartGovernedServiceWithPort({
    serviceId: 'web-native-web-qa',
    serviceName: 'web-native-web-qa',
    preferred: 14935,
    project: 'PolarUI',
  }, {
    runServiceAction: async (serviceId, action) => {
      calls.push(`${action}:${serviceId}`);
      return { ok: true };
    },
    waitForServiceStatus: async (serviceId, status) => {
      calls.push(`wait:${serviceId}:${status}`);
      return { id: serviceId, status };
    },
    claimPort: async (options) => {
      calls.push(`claim:${options.serviceName}:${options.preferred}:${options.project}`);
      return options.preferred;
    },
  });

  assert.deepEqual(calls, [
    'stop:web-native-web-qa',
    'wait:web-native-web-qa:stopped',
    'claim:web-native-web-qa:14935:PolarUI',
    'start:web-native-web-qa',
  ]);
});

test('fails closed without starting when PolarPort returns an alternate port', async () => {
  const services = await import('./governed-qa-services.mjs');
  assert.equal(typeof services.restartGovernedServiceWithPort, 'function');
  const calls = [];

  await assert.rejects(services.restartGovernedServiceWithPort({
    serviceId: 'web-native-web-qa',
    serviceName: 'web-native-web-qa',
    preferred: 14935,
    project: 'PolarUI',
  }, {
    runServiceAction: async (_serviceId, action) => {
      calls.push(action);
      return { ok: true };
    },
    waitForServiceStatus: async () => { calls.push('wait'); },
    claimPort: async () => {
      calls.push('claim');
      return 14940;
    },
    releasePort: async (port, options) => {
      calls.push('release');
      assert.equal(port, 14940);
      assert.deepEqual(options, { serviceName: 'web-native-web-qa', project: 'PolarUI' });
    },
  }), /claimed alternate port 14940 instead of required port 14935/);

  assert.deepEqual(calls, ['stop', 'wait', 'claim', 'release']);
});

test('propagates a governed start failure after reclaiming the exact port', async () => {
  const services = await import('./governed-qa-services.mjs');
  assert.equal(typeof services.restartGovernedServiceWithPort, 'function');
  const calls = [];
  const startFailure = new Error('PolarProcess start failed');

  await assert.rejects(services.restartGovernedServiceWithPort({
    serviceId: 'web-native-web-qa',
    serviceName: 'web-native-web-qa',
    preferred: 14935,
    project: 'PolarUI',
  }, {
    runServiceAction: async (_serviceId, action) => {
      calls.push(action);
      if (action === 'start') throw startFailure;
      return { ok: true };
    },
    waitForServiceStatus: async () => { calls.push('wait'); },
    claimPort: async () => {
      calls.push('claim');
      return 14935;
    },
    releasePort: async (port, options) => {
      calls.push('release');
      assert.equal(port, 14935);
      assert.deepEqual(options, { serviceName: 'web-native-web-qa', project: 'PolarUI' });
    },
  }), startFailure);

  assert.deepEqual(calls, ['stop', 'wait', 'claim', 'start', 'release']);
});

test('surfaces both the primary start failure and owner-safe release failure', async () => {
  const services = await import('./governed-qa-services.mjs');
  const startFailure = new Error('PolarProcess start failed');
  const releaseFailure = new Error('PolarPort owner-safe release failed');
  const calls = [];

  await assert.rejects(services.restartGovernedServiceWithPort({
    serviceId: 'web-native-web-qa',
    serviceName: 'web-native-web-qa',
    preferred: 14935,
    project: 'PolarUI',
  }, {
    runServiceAction: async (_serviceId, action) => {
      calls.push(action);
      if (action === 'start') throw startFailure;
      return { ok: true };
    },
    waitForServiceStatus: async () => { calls.push('wait'); },
    claimPort: async () => {
      calls.push('claim');
      return 14935;
    },
    releasePort: async (port, options) => {
      calls.push('release');
      assert.equal(port, 14935);
      assert.deepEqual(options, { serviceName: 'web-native-web-qa', project: 'PolarUI' });
      throw releaseFailure;
    },
  }), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors, [startFailure, releaseFailure]);
    return true;
  });

  assert.deepEqual(calls, ['stop', 'wait', 'claim', 'start', 'release']);
});
