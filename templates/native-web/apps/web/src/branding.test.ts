import { afterEach, describe, expect, it } from 'vitest';
import { applyProductBranding } from './branding';

afterEach(() => {
  document.documentElement.removeAttribute('data-skin');
  document.documentElement.removeAttribute('style');
});

describe('applyProductBranding', () => {
  it('applies the skin attribute and CSS variable tokens to the document root', () => {
    applyProductBranding({
      skin: 'taoci',
      tokens: { '--paper': '#f7f2e8', '--serif': '"Songti SC", serif' },
    });

    expect(document.documentElement.dataset.skin).toBe('taoci');
    expect(document.documentElement.style.getPropertyValue('--paper')).toBe('#f7f2e8');
    expect(document.documentElement.style.getPropertyValue('--serif')).toBe('"Songti SC", serif');
  });

  it('is a no-op without branding and leaves no partial state', () => {
    applyProductBranding(undefined);

    expect(document.documentElement.dataset.skin).toBeUndefined();
    expect(document.documentElement.getAttribute('style')).toBeNull();
  });

  it('ignores token names that are not CSS custom properties', () => {
    applyProductBranding({ tokens: { color: 'red', '--ink': '#111' } as Record<string, string> });

    expect(document.documentElement.style.getPropertyValue('--ink')).toBe('#111');
    expect(document.documentElement.style.color).toBe('');
  });
});
