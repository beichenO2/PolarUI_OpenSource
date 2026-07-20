export type ProductBranding = {
  skin?: string;
  tokens?: Record<string, string>;
};

// The server validates branding shape and token safety; this boundary only
// refuses non-custom-property names so a stale client can never write
// arbitrary inline styles.
export function applyProductBranding(branding: ProductBranding | undefined): void {
  if (!branding) return;
  const root = document.documentElement;
  if (branding.skin) root.dataset.skin = branding.skin;
  for (const [name, value] of Object.entries(branding.tokens ?? {})) {
    if (!name.startsWith('--')) continue;
    root.style.setProperty(name, value);
  }
}
