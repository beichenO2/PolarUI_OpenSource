/**
 * Browser globals for headless import of PolarUI Vite bundle in Node.
 */
import { JSDOM } from 'jsdom';
import { installNodeDefsFetch } from './shim-fetch-node-defs.mjs';

installNodeDefsFetch();

if (typeof globalThis.window === 'undefined' || !globalThis.document?.querySelector) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
    { url: 'http://127.0.0.1:5170/', pretendToBeVisual: true },
  );
  const { window } = dom;
  const defineGlobal = (name, value) => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, name);
    if (desc && !desc.configurable) return;
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  };
  defineGlobal('window', window);
  defineGlobal('document', window.document);
  defineGlobal('navigator', window.navigator);
  defineGlobal('HTMLElement', window.HTMLElement);
  defineGlobal('Element', window.Element);
  defineGlobal('SVGElement', window.SVGElement);
  defineGlobal('customElements', window.customElements);
  defineGlobal('localStorage', window.localStorage);
  defineGlobal('sessionStorage', window.sessionStorage);
  defineGlobal('MutationObserver', window.MutationObserver);
  defineGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  defineGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  if (!globalThis.fetch) defineGlobal('fetch', window.fetch.bind(window));
}

/** Wait for async mbn() node-defs boot in bundle side-effect. */
export function waitForBundleBoot(ms = 2500) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
