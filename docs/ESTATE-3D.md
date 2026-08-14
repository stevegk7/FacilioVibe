# The 3D estate — engine contract and the patches

`public/estate-engine.js` is **vendored** code: 1,355 lines of ES5 that came from
the Estate Navigator design project and that we do not regenerate. This is the
record of what it expects, what we changed, and why — so the next person does not
have to rediscover it from a blank canvas.

## The contract

```js
const engine = new window.EstateEngine(canvas, data, { onLevel, onSelect, onTags });
```

**Before that line can run**, in this order:

1. `window.THREE` — read once, at construction.
2. `window.EstateEngine` — from `estate-engine.js`.
3. `window.AssetTaxonomy`, `window.PlantRoomModels`, `window.FACILIO_ASSET_CATEGORIES`,
   `window.FACILIO_SPACE_CATEGORIES` — needed **before `buildEstate()`**, which is
   earlier than construction. Missing, nothing throws: every asset silently gets
   `taxonomyId: null`, a generic box model and a grey swatch. Generic boxes on
   Tower B's mechanical floor is the visual tell.
4. `window.ESTATE_BUILDING_TINT_EXTRA` — published by `buildEstate()` and merged by
   the constructor, so `buildEstate()` → `new EstateEngine()` is a fixed order.

`src/estate/loadEngine.ts` owns all of that. Its `script.async = false` is not
cosmetic: dynamically-created scripts default to `async = true`, which would let
the engine execute before the taxonomy and trigger (3) with no error to find it by.

## The patches

All are marked `PATCH (facilio-vision-3d)` in the source.

**A · `api.setPaused(v)`** — the render loop ran unconditionally, and the idle
auto-orbit kept mutating the camera. Since the canvas now outlives the React tree
(below), a parked estate would burn a 60 fps GPU loop behind the live AR camera —
the worst place to spend a phone's thermal budget. Resuming resets `last` so the
`dt` clamp is not handed a multi-minute delta.

**B · Removable listeners** — the five canvas listeners were registered with
anonymous functions, so none could ever be removed. `on()` records its own remover.

**C · A `dispose()` that disposes.** The original was:

```js
api.dispose = function () { disposed = true; ro.disconnect(); renderer.dispose(); };
```

`renderer.dispose()` frees the renderer's own caches and nothing else. Three
separate retention paths survived it:

- every geometry, material and `CanvasTexture` (the building name labels are
  textures on **sprite** materials, so the traversal must cover Sprites);
- `pinTex` / `haloGeo` / `stemGeo` / `stemMat`, closure-scoped and unreachable
  from a scene traversal;
- **`m._pin` / `m._halo`**, which `addPin` writes back onto the *caller's* data.
  React holds that object, so leaving them set keeps the whole scene graph
  reachable no matter how thoroughly everything else was freed. This is the step
  that actually frees the memory, and the one that looks optional.

Plus `window.__estate` (a permanent global pinning the closure) and
`renderer.forceContextLoss()` — the only call that hands the WebGL context back.
Chrome keeps ~16 live contexts and force-loses the **oldest** when a 17th appears,
so without it a canvas still on screen goes black after enough tab switches.

`focusT` and the `flyToFloor` / `flyToMarker` timers are cleared too; left armed
they fired `cb.onLevel` into an unmounted component.

**D · One palette.** The status ramp was nine hardcoded hexes here and a second
copy in the 2D UI. `api.setPalette()` now takes the resolved CSS design tokens, so
a token change repaints the 3D scene.

`src/__tests__/estate-dispose.test.ts` drives the real three r128 against a stubbed
renderer and asserts all of this. Without it the fix silently rots.

## Why the canvas outlives React

`AppShell` renders only the active screen, so a tab switch unmounts the estate.
Rebuilding means ~35k wall vertices, 47 room pads and 39 procedural plant models,
plus a fresh WebGL context each time.

`src/estate/estateHost.ts` keeps one canvas for the tab's life: `release()` parks
it, `acquire()` re-attaches, `destroy()` is only for genuinely invalid state. Two
details that are load-bearing:

- **The wrapper div, not the canvas, is what moves.** `estate-engine.js` observes
  `canvas.parentElement` with a ResizeObserver exactly once and never re-observes.
  Moving a bare canvas between containers would leave the observer on a detached
  node and freeze the aspect ratio — a phone rotated on the AR tab would come back
  stretched.
- **A fresh canvas per engine.** Constructing a second `WebGLRenderer` on a canvas
  that already has a context hands back the *same* context and strands the first
  renderer's program cache.

The side benefit turned out to matter more than the performance: camera position,
open floor and selected asset survive a round-trip to AR, which is what makes the
handoff feel like one app rather than two.

## Offline checks

Both run with no Facilio session and are worth keeping:

- `npm run check` — `smoke-adapter.mjs`. Geometry contract *and* record
  accounting: every asset either rendered or explicitly a test artifact. It also
  asserts the record policy is **idempotent**, which is what lets the providers
  filter upstream while `buildEstate` keeps its own defensive pass for callers
  that feed it raw fixtures.
- `npm run check:3d` — `smoke-plan3d.mjs`. The three.js CAD path against the real
  536 KB of plan data, and the version pin.

`?mock=1` is the app-wide offline data mode and now covers the 3D screen too.

## Known, deliberate

- `PLAN_ASSIGNMENTS` hardcodes this org's building and floor **names**. It belongs
  in the `settings` KV collection so an admin can bind a plan without a deploy.
- `scriptFns.ts`'s `FN_NAMESPACE = 'facilio_vision'` is an **org-scoped**
  scriptengine namespace, so this app reuses the one `facilio-vision` created.
  That is intentional — the script is identical and duplicating it would litter
  the org — but it is a cross-app coupling: deleting the old app's namespace
  breaks work-order creation here.
- `api.addMarker` / `updateMarker` / `setEditMode` / `setLayers` are implemented
  and unused. `addMarker` is the natural way to put AR survey standpoints into the
  scene; it needs a ~15-line `standpoint` branch in `addPin`, which builds
  geometry only for `markerModuleName === 'asset'` today.
