import { z } from 'zod';

export const BUILTIN_COMPONENT_KEYS = [
  'generic_chat',
  'structured_form',
  'card_selection',
  'document_workspace',
] as const;

const actionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(80),
}).strict();

const stageSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(80),
  component_key: z.enum(BUILTIN_COMPONENT_KEYS),
  internal_states: z.array(z.string().min(1)).min(1),
  actions: z.array(actionSchema),
}).strict();

const manifestSchema = z.object({
  contract_version: z.literal('1.0'),
  product: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(100),
    context_label: z.string().min(1).max(30),
    route_label: z.string().min(1).max(30),
  }).strict(),
  workflow: z.object({
    id: z.string().min(1),
    endpoint: z.string().url(),
  }).strict(),
  stages: z.array(stageSchema).min(1),
}).strict();

export type ProductManifest = z.infer<typeof manifestSchema>;

export function parseProductManifest(input: unknown): ProductManifest {
  const parsed = manifestSchema.parse(input);
  const stageKeys = new Set<string>();
  for (const stage of parsed.stages) {
    if (stageKeys.has(stage.key)) throw new Error(`duplicate stage key: ${stage.key}`);
    stageKeys.add(stage.key);
    const actionKeys = new Set<string>();
    for (const action of stage.actions) {
      if (actionKeys.has(action.key)) {
        throw new Error(`duplicate action key in ${stage.key}: ${action.key}`);
      }
      actionKeys.add(action.key);
    }
  }
  return parsed;
}
