import { linear3, fanOut6, react2Loops, denseCorridor } from './fixtures/synthetic-fixtures.ts'
import { loadTaociDenseFixture, loadHermesReactFixture } from './fixtures/workflow-fixtures.ts'
import { routeGraphWires } from './helpers/route-pipeline.ts'
import { computeRoutingStats } from './helpers/wire-invariants.ts'
import { detectCrossings } from '../../src/engine/wire-crossings.ts'

const fixtures = [
  { name: 'linear-3', ...linear3 },
  { name: 'fan-out-6', ...fanOut6 },
  { name: 'react-3-loops', ...react2Loops },
  { name: 'dense-corridor', ...denseCorridor },
  { name: 'taoci-outreach', ...loadTaociDenseFixture() },
  { name: 'hermes', ...loadHermesReactFixture() },
]

console.log('fixture\tnodeCrossings\tfullOverlaps\tcrossings\tlinks')
for (const f of fixtures) {
  if (!f.links.length) continue
  const { paths } = routeGraphWires(f.nodes, f.links, f.backLinks)
  const crossings = detectCrossings(paths).length
  const stats = computeRoutingStats(f.nodes, f.links, paths, crossings)
  console.log(`${f.name}\t${stats.nodeCrossings}\t${stats.fullOverlaps}\t${stats.crossings}\t${f.links.length}`)
}
