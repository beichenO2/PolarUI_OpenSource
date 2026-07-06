#!/usr/bin/env node
/**
 * CLI: deploy preflight JSON for PolarClaw /api/deployments gate.
 * Usage: node lib/deploy-preflight-cli.mjs [--workflow taoci-outreach]
 */
import { runDeployPreflight } from './deploy-preflight.mjs';

const args = process.argv.slice(2);
let workflowId = 'taoci-outreach';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--workflow' && args[i + 1]) workflowId = args[++i];
}

const result = await runDeployPreflight({ workflowId });
process.stdout.write(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
