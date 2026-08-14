/**
 * The 3D scene's lifetime — deliberately OUTSIDE React.
 *
 * AppShell renders only the active screen, so a tab switch unmounts the estate
 * entirely. Left alone that means a new WebGL context per switch (Chrome keeps
 * ~16 and force-loses the oldest, blanking a canvas that is still on screen) and
 * a 1-2 s rebuild of ~35k wall verts, 47 room pads and 39 procedural plant
 * models every time the user comes back.
 *
 * So the canvas outlives the React tree: `release()` parks it, `acquire()`
 * re-attaches it, and `destroy()` is reserved for the cases where the scene is
 * genuinely invalid — new data, sign-out, an unrecoverable error.
 *
 * A side benefit that turned out to matter more than the performance: camera
 * position, open floor and selected asset survive a round-trip to the AR tab.
 * That is what makes the handoff feel like one app instead of two.
 */
import { loadEstateRuntime } from './loadEngine';
import type { EngineCallbacks, EstateData, EstateEngineApi } from './types';

/**
 * The wrapper is created once and stays the canvas's parentElement for the life
 * of the tab. That is load-bearing, not tidiness: estate-engine.js observes
 * `canvas.parentElement` with a ResizeObserver exactly once and never
 * re-observes. Moving a bare canvas between screen containers would leave the
 * observer watching a detached node, and the aspect ratio would freeze at
 * whatever it was — a phone rotated on the AR tab would come back stretched.
 */
let wrapper: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let engine: EstateEngineApi | null = null;
let builtFor: EstateData | null = null;

function ensureWrapper(): HTMLDivElement {
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'estate-canvas-wrap';
  }
  return wrapper;
}

export function currentEngine(): EstateEngineApi | null {
  return engine;
}

/**
 * Mount the scene into `slot`, building it only if the data actually changed.
 *
 * `data` is the caller's useMemo result, so identity changes exactly when a
 * rebuild is required — a refetch or the sample-health toggle — and never on a
 * remount. That is also what makes this safe under StrictMode's double-invoke:
 * the second pass takes the fast path and just re-attaches.
 */
export async function acquire(
  slot: HTMLElement,
  data: EstateData,
  callbacks: EngineCallbacks,
): Promise<EstateEngineApi> {
  await loadEstateRuntime();

  const wrap = ensureWrapper();
  if (wrap.parentElement !== slot) slot.appendChild(wrap);

  if (engine && builtFor === data) {
    engine.setPaused(false);
    return engine;
  }

  destroy();

  // A fresh canvas per engine. Constructing a second WebGLRenderer on a canvas
  // that already has a context hands back the SAME context and strands the first
  // renderer's program cache; a new element is unambiguous.
  const el = document.createElement('canvas');
  wrap.appendChild(el);
  canvas = el;

  const Engine = window.EstateEngine;
  if (!Engine) throw new Error('estate runtime resolved but EstateEngine is missing');
  engine = new Engine(el, data, callbacks);
  builtFor = data;
  return engine;
}

/** Tab switch: keep the scene and its context, stop paying for the frames. */
export function release(): void {
  engine?.setPaused(true);
  wrapper?.remove();
}

/** Real teardown — data replaced, signed out, or the scene is unusable. */
export function destroy(): void {
  engine?.dispose();
  engine = null;
  builtFor = null;
  canvas?.remove();
  canvas = null;
}
