/** ToolCall tool_list 解析 / 序列化（GUI + executor 共用） */

export const META_TOOL_NAMES = new Set(['skill_search', 'skill_activate']);

/** @typedef {{ name: string; desc?: string; description?: string; parameters?: object }} ToolEntry */

/** @param {unknown} raw */
export function parseToolList(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map(normalizeEntry).filter(Boolean);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(normalizeEntry).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** @param {ToolEntry} entry */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = String(entry.name ?? entry.function?.name ?? '').trim();
  if (!name) return null;
  return {
    name,
    desc: entry.desc ?? entry.description ?? entry.function?.description ?? name,
    parameters: entry.parameters ?? entry.function?.parameters ?? { type: 'object', properties: {} },
  };
}

/** @param {ToolEntry[]} tools */
export function serializeToolList(tools) {
  const arr = (tools ?? []).map(normalizeEntry).filter(Boolean);
  return JSON.stringify(arr, null, 2);
}

/** @param {ToolEntry[]} tools */
export function toOpenAITools(tools) {
  return parseToolList(tools).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.desc ?? t.name,
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

/** @param {ToolEntry[]} tools @param {ToolEntry} tool */
export function addTool(tools, tool) {
  const list = parseToolList(tools);
  const entry = normalizeEntry(tool);
  if (!entry || META_TOOL_NAMES.has(entry.name)) return list;
  if (list.some((t) => t.name === entry.name)) return list;
  return [...list, entry];
}

/** @param {ToolEntry[]} tools @param {string} name */
export function removeTool(tools, name) {
  if (META_TOOL_NAMES.has(name)) return parseToolList(tools);
  return parseToolList(tools).filter((t) => t.name !== name);
}

/** @param {ToolEntry[]} tools @param {string[]} names */
export function activateSkillTools(tools, names) {
  let list = parseToolList(tools);
  for (const name of names) {
    list = addTool(list, { name, desc: `[skill] ${name}` });
  }
  return list;
}

export default parseToolList;
