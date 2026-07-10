/**
 * P2a: librechat.yaml modelSpecs patch for http_workflows
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { patchLibreChatHttpWorkflows } from './patch-librechat-http-workflows.mjs';

const SAMPLE = `# PolarChat
version: 1.2.1

modelSpecs:
  enforce: false
  prioritize: true
  list:
    - name: "support-triage"
      label: "Customer support triage"
      default: true
      preset:
        endpoint: "PolarWorkflow"
        model: "support-triage"
    - name: "demo-http"
      label: "HTTP Demo Workflow"
      description: "already present"
      preset:
        endpoint: "PolarWorkflow"
        model: "demo-http"

endpoints:
  custom:
    - name: "PolarWorkflow"
      apiKey: "polar-local"
      baseURL: "http://polar-api:3920/v1"
      models:
        default: ["support-triage", "demo-http"]
        fetch: true
`;

describe('patchLibreChatHttpWorkflows', () => {
  test('no-op when empty list', () => {
    const r = patchLibreChatHttpWorkflows(SAMPLE, []);
    assert.equal(r.added, 0);
    assert.equal(r.yaml, SAMPLE);
  });

  test('appends missing presets using template endpoint name', () => {
    const r = patchLibreChatHttpWorkflows(SAMPLE, [
      { id: 'demo-http', label: 'HTTP Demo', url: 'http://x/run' },
      {
        id: 'mta-python',
        label: 'Python 情报客服',
        description: 'LangGraph via HTTP',
        url: 'http://host.docker.internal:3945/run',
      },
    ]);
    assert.equal(r.added, 1);
    assert.match(r.yaml, /name:\s*"?mta-python"?/);
    assert.match(r.yaml, /label:\s*"?Python 情报客服"?/);
    assert.match(r.yaml, /description:\s*"?LangGraph via HTTP"?/);
    assert.match(r.yaml, /endpoint:\s*"?PolarWorkflow"?/);
    assert.match(r.yaml, /model:\s*"?mta-python"?/);
    // existing demo-http not duplicated
    assert.equal((r.yaml.match(/name:\s*"?demo-http"?/g) || []).length, 1);
    assert.match(r.yaml, /mta-python/);
    assert.match(r.yaml, /default:.*mta-python|-\s*"?mta-python"?/);
  });

  test('uses custom endpoint name from yaml', () => {
    const branded = SAMPLE.replaceAll('PolarWorkflow', '情报客服工作流');
    const r = patchLibreChatHttpWorkflows(branded, [
      { id: 'polarflow-x', label: 'PF', url: 'http://h/run' },
    ]);
    assert.equal(r.added, 1);
    assert.match(r.yaml, /endpoint:\s*"?情报客服工作流"?/);
  });
});
