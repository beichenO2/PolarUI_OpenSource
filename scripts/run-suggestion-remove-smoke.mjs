#!/usr/bin/env node
/** 11 批次外：REMOVE_NODE_DEF → registry 滤 deprecated */
import { bootstrapHeadlessEngine } from './headless-bootstrap.ts'
import { registry } from '../src/engine/registry.ts'

let failed = 0
const ok = m => console.log('OK:', m)
const fail = m => { console.error('FAIL:', m); failed++ }

bootstrapHeadlessEngine()

const ct = '__SmokeDeprecated__'
registry.register({
  class_type: ct,
  category: 'Internal/Test',
  display_name: 'Smoke Deprecated',
  inputs: [],
  outputs: [],
  deprecated: true,
})

const inPalette = registry.getPaletteNodes('WF').some(n => n.class_type === ct)
if (inPalette) fail('deprecated node visible in palette')
else ok('deprecated node hidden from palette')

const stillRegistered = registry.get(ct)
if (!stillRegistered) fail('deprecated node removed from registry')
else ok('deprecated node still in registry (executor read-only)')

console.log(`\n--- suggestion-remove-smoke: ${failed} failures ---`)
process.exit(failed ? 1 : 0)
