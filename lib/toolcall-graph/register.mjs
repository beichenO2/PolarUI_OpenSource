/**
 * ADR-003: ToolCall 复合组件 — intent-only + tool_list + skill 元工具。
 * 执行走 LG _lg_edges 条件路由到明面工具节点（outputs.branch = tool name）。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolList, scanSkillsDir, skillSearch } from '../toolcall-composite.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLARUI_ROOT = join(__dirname, '../..');
const DEFAULT_SKILLS_DIRS = [
  join(POLARUI_ROOT, 'skills'),
  join(process.env.HOME ?? '', '.agents/skills'),
];

let registered = false;
let skillCatalog = null;

function loadSkillCatalog() {
  if (skillCatalog) return skillCatalog;
  const seen = new Set();
  const all = [];
  for (const dir of DEFAULT_SKILLS_DIRS) {
    for (const entry of scanSkillsDir(dir)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      all.push(entry);
    }
  }
  skillCatalog = all;
  return all;
}

function parseJsonMaybe(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeToolDefs(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((v) => {
    const b = v;
    if (b && typeof b === 'object' && b.name && !('type' in b)) {
      return {
        type: 'function',
        function: {
          name: b.name,
          description: b.desc ?? b.description ?? b.name,
          parameters: b.parameters ?? { type: 'object', properties: {} },
        },
      };
    }
    return v;
  });
}

function firstToolName(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return '';
  const tc = toolCalls[0];
  return String(tc?.function?.name ?? tc?.name ?? '');
}

function parseToolArgs(toolCalls) {
  const tc = toolCalls?.[0];
  const raw = tc?.function?.arguments ?? tc?.arguments ?? '{}';
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
  } catch {
    return {};
  }
}

/** 元工具在 ToolCall 内处理，不交给 Switch→明面节点 */
async function handleMetaToolCall(name, args, toolList) {
  const catalog = loadSkillCatalog();
  if (name === 'skill_search') {
    const hits = skillSearch(String(args.query ?? ''), catalog);
    return {
      meta: true,
      tool: name,
      result: hits.map((h) => ({
        name: h.name,
        description: h.description,
        tools: h.toolNames,
      })),
      branch: '',
    };
  }
  if (name === 'skill_activate') {
    const skill = catalog.find((s) => s.name === args.name);
    if (skill) toolList.activateSkill(skill);
    return {
      meta: true,
      tool: name,
      result: { activated: skill?.name ?? args.name, tool_list_size: toolList.list().length },
      branch: '',
    };
  }
  return null;
}

/** @param {typeof import('../../dist/assets/index-Dh0id7gB.js').r} registerExecutor */
export function registerToolcallComposite(registerExecutor) {
  if (registered) return;
  registered = true;

  registerExecutor('ToolCall', async (node, inputs, ctx) => {
    const start = Date.now();
    const toolList = new ToolList();

    const fromInput = normalizeToolDefs(parseJsonMaybe(inputs.tool_definitions ?? inputs.tools, []));
    for (const def of fromInput) toolList.addTool(def);

    const fromParams = normalizeToolDefs(parseJsonMaybe(node.params?.tool_list, []));
    for (const def of fromParams) toolList.addTool(def);

    for (const meta of ToolList.metaTools()) toolList.addTool(meta);

    const tools = toolList.list();
    const model = node.params?.model ?? 'GLM-5.1';
    const prompt = String(inputs.prompt ?? '');

    // headless 测试：跳过 LLM，直接产出 tool_calls
    if (process.env.POLARUI_MOCK_TOOLCALL === '1') {
      const mockTool = String(process.env.POLARUI_MOCK_TOOL_NAME ?? 'FileRead');
      const toolCalls = [{
        id: 'mock_1',
        type: 'function',
        function: { name: mockTool, arguments: JSON.stringify({ path: 'PolarUI/polaris.json' }) },
      }];
      return {
        outputs: {
          tool_calls: toolCalls,
          raw: JSON.stringify({ branch: 'tool', tool: mockTool }),
          tool_list: tools,
          branch: mockTool,
          tool: mockTool,
          state: { ...(ctx.lgAccumulatedState ?? {}), branch: mockTool, tool: mockTool },
        },
        duration_ms: Date.now() - start,
      };
    }

    const mod = await import('../../dist/assets/index-Dh0id7gB.js');
    const getLLMClient = mod.f;
    if (typeof getLLMClient !== 'function') {
      return {
        outputs: { tool_calls: [], raw: '', tool_list: tools, branch: 'finish' },
        duration_ms: Date.now() - start,
        error: 'LLM client (Nb) unavailable in bundle',
      };
    }

    let result;
    try {
      result = await getLLMClient().chat(model, [{ role: 'user', content: prompt }], {
        tools: tools.length ? tools : undefined,
        toolChoice: tools.length ? 'auto' : undefined,
        timeoutMs: 60_000,
      });
    } catch (err) {
      return {
        outputs: { tool_calls: [], raw: String(err), tool_list: tools, branch: 'finish' },
        duration_ms: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let toolCalls = result.toolCalls ?? [];
    let raw = result.content ?? '';

    const metaName = firstToolName(toolCalls);
    if (metaName === 'skill_search' || metaName === 'skill_activate') {
      const meta = await handleMetaToolCall(metaName, parseToolArgs(toolCalls), toolList);
      return {
        outputs: {
          tool_calls: toolCalls,
          raw,
          tool_list: toolList.list(),
          meta_result: meta?.result,
          branch: '',
          state: { ...(ctx.lgAccumulatedState ?? {}), meta_tool: metaName },
        },
        duration_ms: Date.now() - start,
      };
    }

    const branch = firstToolName(toolCalls);
    const state = {
      ...(ctx.lgAccumulatedState ?? {}),
      branch,
      tool: branch,
      tool_calls: toolCalls,
    };

    return {
      outputs: {
        tool_calls: toolCalls,
        raw,
        tool_list: toolList.list(),
        branch,
        tool: branch,
        state,
      },
      duration_ms: Date.now() - start,
    };
  });
}

export default registerToolcallComposite;
