// The 3D runtime loader (src/estate/loadEngine.ts).
//
// This is the piece that keeps the estate's cost off the AR path. Estate
// Navigator loaded three.js in its entry bundle and the four vendored globals as
// blocking <script> tags in <head> — ~180 KB gz parsed on every page load,
// including the phone that only opens the camera. If the memo, the ordering or
// the failure handling regress, nothing visible breaks; the app just gets slower
// and, in the async case, quietly wrong. Hence these tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loaded: string[] = [];

/**
 * Stand in for the browser fetching /public. Appending a <script> in jsdom does
 * not execute it, so drive load/error by hand and record the order.
 */
function autoResolveScripts(behaviour: 'ok' | 'fail' = 'ok') {
  const original = document.head.appendChild.bind(document.head);
  return vi
    .spyOn(document.head, 'appendChild')
    .mockImplementation(((node: Node) => {
      const result = original(node);
      if (node instanceof HTMLScriptElement) {
        loaded.push(node.src);
        queueMicrotask(() => {
          if (behaviour === 'fail') {
            node.dispatchEvent(new Event('error'));
            return;
          }
          // The real scripts self-register these before firing load.
          window.EstateEngine = function EstateEngineStub() {} as never;
          window.AssetTaxonomy = { BY_ID: {}, slugify: (s: string) => s };
          window.FACILIO_ASSET_CATEGORIES = [];
          window.FACILIO_SPACE_CATEGORIES = [];
          node.dispatchEvent(new Event('load'));
        });
      }
      return result;
    }) as typeof document.head.appendChild);
}

async function freshLoader() {
  vi.resetModules();
  return import('../estate/loadEngine');
}

beforeEach(() => {
  loaded.length = 0;
  delete (window as { EstateEngine?: unknown }).EstateEngine;
  delete (window as { AssetTaxonomy?: unknown }).AssetTaxonomy;
  delete (window as { THREE?: unknown }).THREE;
  for (const el of document.querySelectorAll('script[data-estate]')) el.remove();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('estate runtime loader', () => {
  it('injects the four globals in dependency order', async () => {
    autoResolveScripts();
    const { loadEstateRuntime } = await freshLoader();
    await loadEstateRuntime();

    const files = loaded.map((src) => src.split('/').pop()!.split('?')[0]);
    expect(files).toEqual([
      'asset-category-taxonomy.js',
      'plantroom-models.js',
      'facilio-taxonomy.js',
      'estate-engine.js',
    ]);
  });

  it('sets window.THREE before any engine script runs', async () => {
    let threeAtFirstScript: unknown;
    const original = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
      const result = original(node);
      if (node instanceof HTMLScriptElement) {
        // The engine constructor reads window.THREE; the taxonomy scripts run
        // first, so THREE must already be there by the very first injection.
        threeAtFirstScript ??= window.THREE;
        queueMicrotask(() => {
          window.EstateEngine = function EstateEngineStub() {} as never;
          window.AssetTaxonomy = { BY_ID: {}, slugify: (s: string) => s };
          window.FACILIO_ASSET_CATEGORIES = [];
          node.dispatchEvent(new Event('load'));
        });
      }
      return result;
    }) as typeof document.head.appendChild);

    const { loadEstateRuntime } = await freshLoader();
    await loadEstateRuntime();
    expect(threeAtFirstScript).toBeTruthy();
  });

  it('marks every script async=false — order is the whole contract', async () => {
    autoResolveScripts();
    const { loadEstateRuntime } = await freshLoader();
    await loadEstateRuntime();

    const tags = [...document.querySelectorAll<HTMLScriptElement>('script[data-estate]')];
    expect(tags).toHaveLength(4);
    // Dynamically-created scripts default to async=true. Left that way, the
    // engine can execute before the taxonomy exists — and that failure is SILENT:
    // every asset degrades to a generic grey box with no error to find it by.
    expect(tags.every((t) => t.async === false)).toBe(true);
  });

  it('cache-busts the unhashed public/ files with the build id', async () => {
    autoResolveScripts();
    const { loadEstateRuntime } = await freshLoader();
    await loadEstateRuntime();
    // public/ is served unhashed with no cache headers, so a patched
    // estate-engine.js would otherwise be served from a phone's cache forever —
    // silently missing the dispose fix.
    expect(loaded.every((src) => src.includes('?v='))).toBe(true);
  });

  it('loads once no matter how many callers ask', async () => {
    autoResolveScripts();
    const { loadEstateRuntime } = await freshLoader();
    await Promise.all([loadEstateRuntime(), loadEstateRuntime()]);
    await loadEstateRuntime();
    expect(loaded).toHaveLength(4);
  });

  it('rejects rather than degrading when a script fails', async () => {
    autoResolveScripts('fail');
    const { loadEstateRuntime } = await freshLoader();
    await expect(loadEstateRuntime()).rejects.toThrow(/failed to load/);
  });

  it('lets a later attempt retry after a failure', async () => {
    const failing = autoResolveScripts('fail');
    const { loadEstateRuntime } = await freshLoader();
    await expect(loadEstateRuntime()).rejects.toThrow();

    // A flaky network must not poison the tab for the rest of the session.
    failing.mockRestore();
    loaded.length = 0;
    autoResolveScripts('ok');
    await expect(loadEstateRuntime()).resolves.toBeUndefined();
    expect(loaded).toHaveLength(4);
  });

  it('refuses to continue if the taxonomy globals never appeared', async () => {
    const original = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, 'appendChild').mockImplementation(((node: Node) => {
      const result = original(node);
      if (node instanceof HTMLScriptElement) {
        queueMicrotask(() => {
          // Engine present, taxonomy missing — the exact shape of the silent
          // degradation, made loud.
          window.EstateEngine = function EstateEngineStub() {} as never;
          node.dispatchEvent(new Event('load'));
        });
      }
      return result;
    }) as typeof document.head.appendChild);

    const { loadEstateRuntime } = await freshLoader();
    await expect(loadEstateRuntime()).rejects.toThrow(/taxonomy globals missing/);
  });
});
