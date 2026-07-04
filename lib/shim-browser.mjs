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
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.navigator = window.navigator;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.SVGElement = window.SVGElement;
  globalThis.customElements = window.customElements;
  globalThis.localStorage = window.localStorage;
  globalThis.sessionStorage = window.sessionStorage;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  if (!globalThis.fetch) globalThis.fetch = window.fetch.bind(window);
}

/** Wait for async mbn() node-defs boot in bundle side-effect. */
export function waitForBundleBoot(ms = 2500) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
