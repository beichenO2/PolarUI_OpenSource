import type { NodeDef } from './types'

class NodeRegistry {
  private _nodes = new Map<string, NodeDef>()
  private _errors: string[] = []
  private _externalLoaded = false

  register(def: NodeDef): void {
    if (!def.class_type) {
      this._errors.push('register: missing class_type')
      return
    }
    if (this._nodes.has(def.class_type)) {
      this._errors.push(`register: duplicate class_type "${def.class_type}"`)
    }
    if (!def.category) {
      this._errors.push(`register: "${def.class_type}" missing category`)
    }
    this._nodes.set(def.class_type, def)
  }

  /** R8：用户回存的自定义 Agent Take（允许覆盖同名 custom 节点） */
  registerCustom(def: NodeDef): void {
    if (!def.class_type?.startsWith('Custom_')) {
      this._errors.push(`registerCustom: class_type must start with Custom_ (${def.class_type})`)
      return
    }
    this._nodes.set(def.class_type, def)
  }

  /**
   * Load node definitions from an external JSON URL.
   *
   * SSoT 唯一信源：~/Polarisor/PolarUI/node-defs/（树状结构）
   * 支持两种格式：
   *   v1: NodeDef[]（单文件平铺数组，兼容旧 node-defs.json）
   *   v2: { version: 2, files: string[] }（索引 + 多子文件）
   */
  async loadFromUrl(url: string): Promise<{ loaded: number; errors: string[] }> {
    const errors: string[] = []
    try {
      const bustUrl = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now()
      const res = await fetch(bustUrl, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
      if (!res.ok) {
        errors.push(`HTTP ${res.status} from ${url}`)
        return { loaded: 0, errors }
      }
      const data = await res.json()

      if (Array.isArray(data)) {
        return this._loadDefsArray(data, url, errors)
      }

      if (data && data.version === 2 && Array.isArray(data.files)) {
        return this._loadTreeIndex(data.files, url, errors)
      }

      errors.push(`Unknown format from ${url}: expected NodeDef[] or { version: 2, files: [] }`)
      return { loaded: 0, errors }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`Failed to load ${url}: ${msg}`)
      return { loaded: 0, errors }
    }
  }

  private _loadDefsArray(defs: NodeDef[], source: string, errors: string[]): { loaded: number; errors: string[] } {
    let count = 0
    for (const def of defs) {
      if (!def.class_type || !def.category) {
        errors.push(`Skipped invalid def: ${JSON.stringify(def).slice(0, 80)}`)
        continue
      }
      this._nodes.set(def.class_type, def)
      count++
    }
    this._externalLoaded = true
    console.log(`[PolarUI Registry] Loaded ${count} node defs from ${source}`)
    return { loaded: count, errors }
  }

  private async _loadTreeIndex(files: string[], indexUrl: string, errors: string[]): Promise<{ loaded: number; errors: string[] }> {
    const baseUrl = indexUrl.substring(0, indexUrl.lastIndexOf('/') + 1)
    let totalCount = 0

    const results = await Promise.allSettled(
      files.map(f => fetch(baseUrl + f + '?_t=' + Date.now(), { signal: AbortSignal.timeout(5000), cache: 'no-store' }).then(r => r.json()))
    )

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') {
        errors.push(`Failed to load ${files[i]}: ${r.reason}`)
        continue
      }
      if (!Array.isArray(r.value)) {
        errors.push(`${files[i]}: expected array, got ${typeof r.value}`)
        continue
      }
      const sub = this._loadDefsArray(r.value as NodeDef[], files[i], errors)
      totalCount += sub.loaded
    }

    this._externalLoaded = true
    console.log(`[PolarUI Registry] Loaded ${totalCount} node defs from ${files.length} files (tree v2)`)
    return { loaded: totalCount, errors }
  }

  get externalLoaded(): boolean {
    return this._externalLoaded
  }

  get(classType: string): NodeDef | undefined {
    return this._nodes.get(classType)
  }

  getStrict(classType: string): NodeDef {
    const def = this._nodes.get(classType)
    if (!def) {
      const msg = `Unknown node type "${classType}" — not registered. Available: ${Array.from(this._nodes.keys()).join(', ')}`
      console.error(`[PolarUI Registry] ${msg}`)
      throw new Error(msg)
    }
    return def
  }

  getAll(): NodeDef[] {
    return Array.from(this._nodes.values())
  }

  /** 左栏 palette：统一组件集（仅隐藏 Internal / palette_hidden） */
  getPaletteNodes(): NodeDef[] {
    return this.getAll().filter(n => {
      if (n.palette_hidden || n.deprecated) return false
      if (n.category.startsWith('Internal/')) return false
      return true
    })
  }

  /** @deprecated ADR-011: library is no longer a component dimension */
  getAllByLibrary(_library?: string): NodeDef[] {
    return this.getAll()
  }

  getByCategory(category: string): NodeDef[] {
    return this.getAll().filter(n => n.category === category)
  }

  getCategories(): string[] {
    const cats = new Set(this.getAll().map(n => n.category))
    return Array.from(cats).sort()
  }

  getSubCategories(topCategory: string): string[] {
    const subs = new Set<string>()
    for (const n of this._nodes.values()) {
      if (n.category.startsWith(topCategory + '/')) {
        subs.add(n.category.substring(topCategory.length + 1))
      }
    }
    return Array.from(subs).sort()
  }

  validate(classType: string): { valid: boolean; errors: string[] } {
    const errors: string[] = []
    const def = this._nodes.get(classType)
    if (!def) {
      errors.push(`Unknown node type: "${classType}"`)
      return { valid: false, errors }
    }
    if (!def.inputs) errors.push(`"${classType}": missing inputs array`)
    if (!def.outputs) errors.push(`"${classType}": missing outputs array`)
    return { valid: errors.length === 0, errors }
  }

  getRegistrationErrors(): string[] {
    return [...this._errors]
  }

  /**
   * Update model options for all nodes that have a 'model' param with type 'select'.
   * Called after fetching available models from PolarPrivate /v1/models.
   */
  updateModelOptions(modelIds: string[]): void {
    if (modelIds.length === 0) return
    for (const def of this._nodes.values()) {
      if (!def.params?.model) continue
      const p = def.params.model
      if (p.type === 'select' && Array.isArray(p.options)) {
        p.options = modelIds
        if (!modelIds.includes(p.default as string)) {
          p.default = modelIds[0]
        }
      }
    }
  }
}

export const registry = new NodeRegistry()
