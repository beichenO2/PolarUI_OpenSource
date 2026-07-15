import { join } from 'node:path';

export const TEMPLATE_FLAVORS = Object.freeze(['legacy', 'native']);

export function resolveTemplateSource({ flavor, polaruiRoot, webRoot }) {
  if (flavor === 'native') return join(polaruiRoot, 'templates/native-web');
  if (flavor === 'legacy') return join(webRoot, '_template');
  throw new Error(`unsupported template flavor: ${flavor}`);
}
