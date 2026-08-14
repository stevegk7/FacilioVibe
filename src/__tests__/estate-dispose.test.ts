// estate-engine.js's dispose(), which the merge had to rewrite.
//
// The original freed nothing: renderer.dispose() clears the renderer's own
// caches and leaves every geometry, material and canvas texture resident, the
// canvas listeners attached, the WebGL context held, and three.js objects
// written back onto the CALLER's data (m._pin / m._halo) keeping the whole scene
// graph reachable from React state. In an app where the estate mounts and
// unmounts on tab switches that is a leak per switch plus, at ~16 live contexts,
// a canvas that goes black while still on screen.
//
// This runs the REAL three r128 — the same build the browser gets — and stubs
// only WebGLRenderer, which is the one piece that genuinely needs a GL context
// jsdom cannot provide. Disposal is observed by spying on three's own prototypes,
// so the assertions are about real geometries and real materials.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const freed = { geometries: new Set<object>(), materials: new Set<object>(), textures: new Set<object>() };
let contextLost = false;

/** Wrap three's own dispose() so we can see exactly what the engine released. */
function spyOnDisposal() {
  const wrap = (proto: { dispose?: () => void }, bucket: Set<object>) => {
    const original = proto.dispose;
    proto.dispose = function patched(this: object) {
      bucket.add(this);
      original?.call(this);
    };
  };
  wrap(THREE.BufferGeometry.prototype, freed.geometries);
  wrap(THREE.Material.prototype, freed.materials);
  wrap(THREE.Texture.prototype, freed.textures);
}

/** jsdom has no 2D context; the engine draws building labels and pin sprites. */
function stubCanvas2d() {
  const base = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: '', textBaseline: '', globalAlpha: 1, shadowBlur: 0, shadowColor: '',
    fillText() {}, strokeText() {}, fillRect() {}, clearRect() {}, strokeRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {},
    stroke() {}, save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    drawImage() {}, roundRect() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: (t: string) => ({ width: t.length * 6 }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4), width: w, height: h,
    }),
    putImageData() {},
  };
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    return { ...base, canvas: this };
  } as unknown as HTMLCanvasElement['getContext'];
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
}

class StubRenderer {
  domElement: HTMLCanvasElement;
  info = { memory: { geometries: 0, textures: 0 }, render: { calls: 0 } };
  constructor(opts: { canvas?: HTMLCanvasElement } = {}) {
    this.domElement = opts.canvas ?? document.createElement('canvas');
  }
  setPixelRatio() {}
  setSize() {}
  render() {
    this.info.render.calls += 1;
  }
  dispose() {}
  forceContextLoss() {
    contextLost = true;
  }
}

function loadEngine() {
  const file = path.resolve(process.cwd(), 'public/estate-engine.js');
  // eslint-disable-next-line no-new-func
  new Function(fs.readFileSync(file, 'utf8'))();
}

/** A minimal but real estate: one building, one floor, one space, one asset. */
function tinyEstate() {
  return {
    name: 'Test Estate',
    siteNames: ['Site'],
    counts: {},
    buildings: [
      {
        id: '1',
        recordId: 1,
        name: 'Tower A',
        w: 30, d: 25, x: 0, z: 0, nF: 1,
        floors: [
          {
            recordId: 11,
            name: 'G',
            spaces: [{ recordId: 21, name: 'Plant Room', polygon: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }],
            markers: [
              {
                recordId: 31,
                markerModuleName: 'asset',
                name: 'Chiller CH-01',
                code: 'CH-01',
                status: 'healthy',
                spaceId: 21,
                x: 0,
                z: 0,
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Every engine this file builds, so teardown can guarantee none is left running.
 *
 * A live engine is a requestAnimationFrame loop doing real per-frame work —
 * applyState, the tag projection, the wall-height sweep. This file builds one per
 * test, and vitest runs files in PARALLEL: a handful of stray loops here become
 * CPU contention that makes timing-sensitive tests in other files fail. They did.
 */
const engines: EstateEngineApi[] = [];

type EstateEngineApi = InstanceType<NonNullable<typeof window.EstateEngine>>;

function mountEngine(data: ReturnType<typeof tinyEstate>, callbacks = {}) {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  // estate-engine.js is a constructor FUNCTION, callable with or without `new`;
  // the typed surface declares the `new` form, so use it.
  const engine = new window.EstateEngine!(canvas, data as never, callbacks);
  // Nothing here asserts anything the render loop produces — every assertion is
  // a synchronous state change (enter, select, mode, dispose). Park the loop
  // immediately so these tests cost CPU once, not sixty times a second.
  engine.setPaused(true);
  engines.push(engine);
  return engine;
}

describe('estate-engine dispose()', () => {
  beforeAll(() => {
    stubCanvas2d();
    spyOnDisposal();
    (window as unknown as { THREE: unknown }).THREE = { ...THREE, WebGLRenderer: StubRenderer };
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    loadEngine();
  });

  beforeEach(() => {
    freed.geometries.clear();
    freed.materials.clear();
    freed.textures.clear();
    contextLost = false;
  });

  // A test that fails early would otherwise leave its engine's loop running for
  // the rest of the file — and, because files run in parallel, for everyone else.
  afterEach(() => {
    while (engines.length) {
      const engine = engines.pop();
      try {
        engine?.dispose();
      } catch {
        /* already disposed by the test itself — that is the normal path */
      }
    }
  });

  it('runs against the real three r128 the browser gets', () => {
    expect(THREE.REVISION).toBe('128');
    expect(typeof window.EstateEngine).toBe('function');
  });

  it('frees GPU resources, clears the caller back-refs, and releases the context', () => {
    const data = tinyEstate();
    const engine = mountEngine(data);
    expect(window.__estate).toBe(engine);

    // The engine writes three.js objects back onto the caller's data. React holds
    // that object, so if dispose() leaves them set the entire scene graph stays
    // reachable no matter what else was freed. This is the step that matters most.
    const marker = data.buildings[0].floors[0].markers[0] as Record<string, unknown>;
    expect(marker._pin ?? marker._halo).toBeTruthy();

    engine.dispose();

    expect(freed.geometries.size).toBeGreaterThan(0);
    expect(freed.materials.size).toBeGreaterThan(0);
    // Building name labels are CanvasTextures on sprite materials — reachable
    // only if the traversal covers Sprites, not just Meshes.
    expect(freed.textures.size).toBeGreaterThan(0);

    expect(marker._pin).toBeNull();
    expect(marker._halo).toBeNull();
    const space = data.buildings[0].floors[0].spaces[0] as Record<string, unknown>;
    expect(space._mesh).toBeNull();
    expect(space._group).toBeNull();

    // Only forceContextLoss() hands the WebGL context back; without it Chrome
    // force-loses the OLDEST context once ~16 pile up, blanking a live canvas.
    expect(contextLost).toBe(true);
    // A permanent global would pin the whole closure past every teardown.
    expect(window.__estate).toBeNull();
  });

  it('is safe to call twice — teardown races a tab switch', () => {
    const engine = mountEngine(tinyEstate());
    engine.dispose();
    expect(() => engine.dispose()).not.toThrow();
  });

  it('setPaused parks the scene without tearing it down', () => {
    const engine = mountEngine(tinyEstate());
    expect(typeof engine.setPaused).toBe('function');

    engine.setPaused(true);
    // Still usable — parked, not destroyed. This is what lets the canvas survive
    // a round-trip to the AR tab with its camera and selection intact.
    expect(engine.getState()).toEqual({ level: 0, buildingId: null, floorId: null });
    engine.enterBuilding('1');
    expect(engine.getState().buildingId).toBe('1');

    engine.setPaused(false);
    expect(engine.getState().buildingId).toBe('1');
    engine.dispose();
  });

  it('setPlanMode raises the plan walls and re-frames, without rebuilding', () => {
    // A CAD floor is a drawing (0.85 m walls, near top-down) or a space (2.7 m
    // walls, oblique). The geometry is identical either way — the wall volume is
    // built at unit height and carried by a group whose scale.y is the height —
    // so the toggle must not re-merge a single segment.
    const data = tinyEstate();
    (data.buildings[0].floors[0] as Record<string, unknown>).plan = {
      widthM: 12,
      depthM: 9,
      rooms: [],
      layers: { walls: [[[-5, -4], [5, -4]], [[5, -4], [5, 4]]], doors: [], glazing: [], stairs: [], furniture: [] },
    };
    const engine = mountEngine(data);

    expect(engine.getPlanMode()).toBe('drawing');
    const madeInDrawing = freed.geometries.size;

    engine.enterBuilding('1');
    engine.enterFloor('1', 11);
    engine.setPlanMode('solid');
    expect(engine.getPlanMode()).toBe('solid');

    // Nothing was disposed and rebuilt to change modes.
    expect(freed.geometries.size).toBe(madeInDrawing);

    engine.setPlanMode('drawing');
    expect(engine.getPlanMode()).toBe('drawing');
    // An unknown mode is ignored rather than blanking the floor.
    engine.setPlanMode('nonsense' as never);
    expect(engine.getPlanMode()).toBe('drawing');
    engine.dispose();
  });

  /* ---------- walk-in ---------- */

  /** A 12 x 9 m room: four outer walls, one divider, on floor 11 of building '1'. */
  function planEstate() {
    const data = tinyEstate();
    (data.buildings[0].floors[0] as Record<string, unknown>).plan = {
      widthM: 12,
      depthM: 9,
      rooms: [{ id: 1, area: 50, cx: -3, cz: 0, x0: -6, z0: -4.5, x1: 0, z1: 4.5, rects: [[-6, -4.5, 0, 4.5]] }],
      layers: {
        walls: [
          [[-6, -4.5], [6, -4.5]], [[6, -4.5], [6, 4.5]],
          [[6, 4.5], [-6, 4.5]], [[-6, 4.5], [-6, -4.5]],
          [[0, -4.5], [0, 4.5]],
        ],
        doors: [], glazing: [], stairs: [], furniture: [],
      },
    };
    return data;
  }

  interface WalkDebug {
    camMode: string;
    walk: { x: number; y: number; z: number; yaw: number; pitch: number };
    walkSegs: number;
  }
  const dbg = (engine: ReturnType<typeof mountEngine>) =>
    (engine as unknown as { _debug(): WalkDebug })._debug();

  it('refuses to walk into a floor that has no plan', () => {
    // A schematic floor's rooms are laid out, not surveyed. Standing inside them
    // would present invented geometry as a place.
    const engine = mountEngine(tinyEstate());
    engine.enterBuilding('1');
    engine.enterFloor('1', 11);
    expect(engine.setCameraMode('walk')).toBe(false);
    expect(engine.getCameraMode()).toBe('orbit');
    engine.dispose();
  });

  it('refuses to walk in from the estate or building level', () => {
    const engine = mountEngine(planEstate());
    expect(engine.setCameraMode('walk')).toBe(false);   // level 0
    engine.enterBuilding('1');
    expect(engine.setCameraMode('walk')).toBe(false);   // level 1
    engine.dispose();
  });

  it('walks in on a plan floor, and forces the walls to room height', () => {
    const engine = mountEngine(planEstate());
    engine.enterBuilding('1');
    engine.enterFloor('1', 11);
    expect(engine.setCameraMode('walk')).toBe(true);
    expect(engine.getCameraMode()).toBe('walk');
    // Drawing-height walls are 0.85 m — you would be standing over them.
    expect(engine.getPlanMode()).toBe('solid');
    engine.dispose();
  });

  it('leaves on Back rather than changing level out from under the camera', () => {
    const engine = mountEngine(planEstate());
    engine.enterBuilding('1');
    engine.enterFloor('1', 11);
    engine.setCameraMode('walk');

    engine.back();
    expect(engine.getCameraMode()).toBe('orbit');
    // …and it is still the same floor: one Back left the room, not the floor.
    expect(engine.getState()).toEqual({ level: 2, buildingId: '1', floorId: 11 });
    engine.dispose();
  });

  it('dropping to Drawing leaves walk, instead of sinking the walls below eye level', () => {
    const engine = mountEngine(planEstate());
    engine.enterBuilding('1');
    engine.enterFloor('1', 11);
    engine.setCameraMode('walk');

    engine.setPlanMode('drawing');
    expect(engine.getCameraMode()).toBe('orbit');
    expect(engine.getPlanMode()).toBe('drawing');
    engine.dispose();
  });

  it('reports every mode change, including the ones it makes itself', () => {
    const seen: string[] = [];
    const engine = mountEngine(planEstate(), { onCameraMode: (m: string) => seen.push(m) });

    engine.enterBuilding('1');
    engine.enterFloor('1', 11);
    engine.setCameraMode('walk');
    engine.back();               // the engine's own decision to leave
    expect(seen).toEqual(['walk', 'orbit']);
    engine.dispose();
  });

  it('accepts on-screen movement input without a keyboard', () => {
    const engine = mountEngine(planEstate());
    engine.enterBuilding('1');
    engine.enterFloor('1', 11);
    engine.setCameraMode('walk');
    // Out-of-range values are clamped rather than teleporting the camera.
    expect(() => engine.setWalkInput(5, -5)).not.toThrow();
    expect(() => engine.setWalkInput(0, 0)).not.toThrow();
    engine.dispose();
  });

  it('indexes the floor’s own wall geometry to collide against', () => {
    // The walls you bump into are the walls that were drawn — there is no second
    // collision model to drift out of sync with the drawing.
    const engine = mountEngine(planEstate());
    engine.enterBuilding('1');
    engine.enterFloor('1', 11);
    engine.setCameraMode('walk');
    expect(dbg(engine).walkSegs).toBe(5);   // four outer walls + the divider
    engine.dispose();
  });

  it('stands you at eye level in the room, not on the slab', () => {
    const engine = mountEngine(planEstate());
    engine.enterBuilding('1');
    engine.enterFloor('1', 11);
    engine.setCameraMode('walk');
    const { walk } = dbg(engine);
    // floor 0 slab top is 0.24; eye height 1.62 above it.
    expect(walk.y).toBeCloseTo(0.24 + 1.62, 2);
    // …and inside the room the plan says is biggest, not at the plate origin.
    expect(walk.x).toBeLessThan(0);
    expect(Math.abs(walk.z)).toBeLessThan(4.5);
    engine.dispose();
  });

  it('pushes the start position out of a wall it would otherwise begin inside', () => {
    // The room centroid is put ON the divider wall. Spawning there would drop the
    // camera inside solid geometry, which is the one place collision can never
    // recover from — it has no free direction to slide toward.
    const data = planEstate();
    const plan = (data.buildings[0].floors[0] as Record<string, unknown>).plan as {
      rooms: { cx: number; cz: number }[];
    };
    plan.rooms[0].cx = 0;   // exactly on the [[0,-4.5],[0,4.5]] divider
    plan.rooms[0].cz = 0;

    const engine = mountEngine(data);
    engine.enterBuilding('1');
    engine.enterFloor('1', 11);
    engine.setCameraMode('walk');

    const { walk } = dbg(engine);
    // Pushed clear of the divider by at least the body radius.
    expect(Math.abs(walk.x)).toBeGreaterThanOrEqual(0.33);
    engine.dispose();
  });

  it('setPalette repoints the status ramp at the app design tokens', () => {
    const engine = mountEngine(tinyEstate());
    expect(typeof engine.setPalette).toBe('function');
    // Unknown and omitted keys must be ignored rather than blanking a colour.
    expect(() => engine.setPalette({ critical: 0x123456, nonsense: 1 } as never)).not.toThrow();
    expect(() => engine.setPalette(undefined as never)).not.toThrow();
    engine.dispose();
  });
});
