/**
 * Loads the 3D runtime, once, on first use.
 *
 * Estate Navigator loaded three.js in its entry bundle and the four vendored
 * globals as blocking <script> tags in <head> — ~149 KB gz of three plus ~30 KB
 * gz of engine, parsed on every page load. In a merged app that is paid by the
 * technician who only ever opens the camera. Nothing here is reachable from the
 * AR / Surveys / Wayfinder chunks, so that session downloads none of it.
 *
 * Order is the whole contract:
 *   1. window.THREE must exist before the first `new EstateEngine(...)` — the
 *      constructor reads it once, at construction.
 *   2. the taxonomy globals must exist before buildEstate() runs, which is
 *      EARLIER than construction. Miss this and nothing throws: every asset
 *      silently degrades to a generic grey box. Generic boxes on Tower B's
 *      mechanical floor is the visual tell.
 *   3. buildEstate() publishes window.ESTATE_BUILDING_TINT_EXTRA, which the
 *      constructor merges — so buildEstate() must run BEFORE construction.
 */

const SCRIPTS = [
  'asset-category-taxonomy.js',
  'plantroom-models.js',
  'facilio-taxonomy.js',
  'estate-engine.js',
] as const;

let runtime: Promise<void> | null = null;

function injectScript(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-estate="${file}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`estate runtime: ${file} failed`)));
      return;
    }
    const el = document.createElement('script');
    // BASE_URL, never a hardcoded '/' — the source app broke under any sub-path
    // deploy. The build id busts the cache: files in public/ are unhashed and the
    // platform sends no cache headers, so a patched estate-engine.js would
    // otherwise be served from a phone's cache indefinitely, silently missing the
    // dispose fix.
    el.src = `${import.meta.env.BASE_URL}${file}?v=${encodeURIComponent(__BUILD_ID__)}`;
    // REQUIRED. Dynamically-created scripts default to async=true, which would let
    // estate-engine.js execute before the taxonomy globals exist — the silent
    // degradation described above, with no error to find it by.
    el.async = false;
    el.dataset.estate = file;
    el.addEventListener('load', () => {
      el.dataset.loaded = '1';
      resolve();
    });
    el.addEventListener('error', () => reject(new Error(`estate runtime: ${file} failed to load`)));
    document.head.appendChild(el);
  });
}

/** Resolves when three.js and all four vendored globals are ready to use. */
export function loadEstateRuntime(): Promise<void> {
  runtime ??= (async () => {
    try {
      const THREE = await import('three');
      window.THREE = THREE;
      // Sequential, not Promise.all: `async = false` orders execution but these
      // still have to be appended in order to be honoured as a group.
      for (const file of SCRIPTS) await injectScript(file);
      if (!window.EstateEngine) {
        throw new Error('estate-engine.js loaded but window.EstateEngine is undefined');
      }
      if (!window.AssetTaxonomy || !window.FACILIO_ASSET_CATEGORIES) {
        throw new Error('estate taxonomy globals missing — assets would render as generic boxes');
      }
    } catch (err) {
      // Let the next attempt retry rather than caching a failure forever: this
      // fails on a flaky network as readily as on a real bug.
      //
      // Clearing the half-loaded tags is not optional. injectScript reuses any
      // existing script[data-estate] and waits on its load/error — and a tag that
      // already errored will never fire either again, so leaving it behind makes
      // every retry hang forever instead of failing.
      for (const el of document.querySelectorAll('script[data-estate]')) {
        if ((el as HTMLScriptElement).dataset.loaded !== '1') el.remove();
      }
      runtime = null;
      throw err;
    }
  })();
  return runtime;
}

/** Test seam — drops the memo so a suite can exercise the load path repeatedly. */
export function resetEstateRuntimeForTests(): void {
  runtime = null;
  for (const el of document.querySelectorAll('script[data-estate]')) el.remove();
}
