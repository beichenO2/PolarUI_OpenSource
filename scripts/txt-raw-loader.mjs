/**
 * Node/tsx loader shim for Vite-style `*.txt?raw` imports (CLI smoke tests).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function load(url, _context, nextLoad) {
  if (url.includes('.txt?raw') || url.includes('.txt&raw')) {
    const filePath = fileURLToPath(url.replace(/\?raw.*$/, '').replace(/&raw.*$/, ''))
    const source = readFileSync(filePath, 'utf8')
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(source)}`,
    }
  }
  return nextLoad(url)
}
