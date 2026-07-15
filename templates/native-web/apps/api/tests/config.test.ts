import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://polar:polar@127.0.0.1:5432/polar',
  AUTH_PEPPER: 'test-pepper-with-at-least-32-characters',
  PUBLIC_APP_ORIGIN: 'http://127.0.0.1:3920',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_FROM: 'Polar <no-reply@example.test>',
  COOKIE_SECURE: 'false',
};

describe('loadConfig', () => {
  it('loads localhost test configuration', () => {
    const config = loadConfig(valid);
    expect(config.cookie.secure).toBe(false);
    expect(config.sessionTtlSeconds).toBe(30 * 24 * 60 * 60);
    expect(config.verificationTtlSeconds).toBe(10 * 60);
    expect(config.workflowEndpointOverride).toBeNull();
    expect(config.workflowTimeoutMs).toBe(60_000);
  });

  it('accepts a workflow endpoint override and positive timeout', () => {
    const config = loadConfig({
      ...valid,
      WORKFLOW_ENDPOINT_OVERRIDE: 'http://host.docker.internal:8065/run',
      WORKFLOW_TIMEOUT_MS: '5000',
    });
    expect(config.workflowEndpointOverride).toBe('http://host.docker.internal:8065/run');
    expect(config.workflowTimeoutMs).toBe(5000);
    expect(() => loadConfig({ ...valid, WORKFLOW_TIMEOUT_MS: '0' })).toThrow(/WORKFLOW_TIMEOUT_MS/);
    expect(() => loadConfig({ ...valid, WORKFLOW_ENDPOINT_OVERRIDE: 'not-a-url' }))
      .toThrow(/WORKFLOW_ENDPOINT_OVERRIDE/);
    expect(loadConfig({ ...valid, WORKFLOW_ENDPOINT_OVERRIDE: '' }).workflowEndpointOverride).toBeNull();
  });

  it('requires HTTPS and secure cookies in production', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/https/i);
    expect(() => loadConfig({
      ...valid,
      NODE_ENV: 'production',
      PUBLIC_APP_ORIGIN: 'https://workflow.example.com',
      COOKIE_SECURE: 'false',
    })).toThrow(/secure/i);
  });

  it('rejects missing database and short pepper values', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...valid, AUTH_PEPPER: 'short' })).toThrow(/AUTH_PEPPER/);
  });

  it('accepts only explicit trusted proxy addresses and networks', () => {
    expect(loadConfig({ ...valid, TRUST_PROXY: '127.0.0.1,10.0.0.0/8' }).trustProxy)
      .toEqual(['127.0.0.1', '10.0.0.0/8']);
    expect(() => loadConfig({ ...valid, TRUST_PROXY: '*' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...valid, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });
});
