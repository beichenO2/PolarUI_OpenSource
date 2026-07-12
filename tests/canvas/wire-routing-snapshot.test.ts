/**
 * Waypoint golden snapshots for wire routing (deterministic QA gate).
 * Regenerate goldens: UPDATE_GOLDEN=1 node --import tsx --test tests/canvas/wire-routing-snapshot.test.ts
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeGraphWires } from './helpers/route-pipeline.ts'
import { denseCorridor, react2Loops } from './fixtures/synthetic-fixtures.ts'
import { loadHermesReactFixture } from './fixtures/workflow-fixtures.ts'
import type { NodeInstance, Link } from '../../src/engine/types'
import type { Vec2 } from '../../src/engine/node-geometry'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(HERE, 'fixtures')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

interface SnapshotFixture {
  name: string
  nodes: NodeInstance[]
  links: Link[]
  backLinks: Set<string>
}

interface GoldenLink {
  id: string
  waypoints: [number, number][]
}

interface GoldenSnapshot {
  fixture: string
  links: GoldenLink[]
}

const SNAPSHOT_FIXTURES: SnapshotFixture[] = [
  { name: 'dense-corridor', ...denseCorridor },
  { name: 'react-3-loops', ...react2Loops },
  { name: 'hermes', ...loadHermesReactFixture() },
]

function roundCoord(n: number): number {
  return Math.round(n * 100) / 100
}

function goldenPath(name: string): string {
  return join(FIXTURES_DIR, `waypoints-${name}.golden.json`)
}

function serializeSnapshot(fixture: SnapshotFixture): GoldenSnapshot {
  const { paths } = routeGraphWires(fixture.nodes, fixture.links, fixture.backLinks)
  const sortedIds = [...fixture.links.map(l => l.id)].sort()
  return {
    fixture: fixture.name,
    links: sortedIds.map(id => ({
      id,
      waypoints: (paths.get(id) ?? []).map(p => [roundCoord(p.x), roundCoord(p.y)] as [number, number]),
    })),
  }
}

function writeGolden(fixture: SnapshotFixture): void {
  const snapshot = serializeSnapshot(fixture)
  writeFileSync(goldenPath(fixture.name), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
}

function readGolden(name: string): GoldenSnapshot {
  const raw = readFileSync(goldenPath(name), 'utf8')
  return JSON.parse(raw) as GoldenSnapshot
}

function diffSnapshots(actual: GoldenSnapshot, expected: GoldenSnapshot): string {
  const lines: string[] = []
  const expectedById = new Map(expected.links.map(l => [l.id, l]))
  for (const link of actual.links) {
    const exp = expectedById.get(link.id)
    if (!exp) {
      lines.push(`missing golden link: ${link.id}`)
      continue
    }
    const a = JSON.stringify(link.waypoints)
    const e = JSON.stringify(exp.waypoints)
    if (a !== e) {
      lines.push(`${link.id}: expected ${e}, got ${a}`)
    }
  }
  for (const link of expected.links) {
    if (!actual.links.some(l => l.id === link.id)) {
      lines.push(`extra link in golden only: ${link.id}`)
    }
  }
  return lines.join('\n')
}

describe('wire routing waypoint snapshots', () => {
  for (const fixture of SNAPSHOT_FIXTURES) {
    it(`${fixture.name} matches golden waypoints`, () => {
      const actual = serializeSnapshot(fixture)
      const path = goldenPath(fixture.name)

      if (UPDATE) {
        writeGolden(fixture)
        return
      }

      assert.ok(existsSync(path), `golden missing: ${path} (run UPDATE_GOLDEN=1)`)
      const expected = readGolden(fixture.name)
      const diff = diffSnapshots(actual, expected)
      assert.equal(diff, '', diff || `waypoint drift in ${fixture.name}`)
    })
  }
})
