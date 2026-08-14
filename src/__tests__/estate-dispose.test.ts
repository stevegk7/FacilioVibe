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
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

function mountEngine(data: ReturnType<typeof tinyEstate>) {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  // estate-engine.js is a constructor FUNCTION, callable with or without `new`;
  // the typed surface declares the `new` form, so use it.
  return new window.EstateEngine!(canvas, data as never, {});
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

  it('setPalette repoints the status ramp at the app design tokens', () => {
    const engine = mountEngine(tinyEstate());
    expect(typeof engine.setPalette).toBe('function');
    // Unknown and omitted keys must be ignored rather than blanking a colour.
    expect(() => engine.setPalette({ critical: 0x123456, nonsense: 1 } as never)).not.toThrow();
    expect(() => engine.setPalette(undefined as never)).not.toThrow();
    engine.dispose();
  });
});
