// The plate's framing has one job: contain the floor AND the whole route, and
// refuse to draw when there is nothing real. Both halves matter — a clipped last
// segment is the moment a technician stops trusting the picture, and an empty
// box renders as a divide-by-zero smear rather than as nothing.
import { describe, expect, it } from 'vitest';
import { plateBounds, polygonPath, polylinePath } from './plate';

describe('plateBounds', () => {
  it('frames wall geometry with padding', () => {
    const box = plateBounds({ walls: [[[-5, -4], [5, -4], [5, 4], [-5, 4]]] }, [], 1);
    expect(box).toEqual({ minX: -6, minZ: -5, width: 12, height: 10 });
  });

  it('unions the route, so a leg leaving the drawn geometry is not clipped', () => {
    // The route runs past the east wall to a stair core the plan does not cover.
    const box = plateBounds(
      { walls: [[[-5, -4], [5, -4], [5, 4], [-5, 4]]] },
      [{ x: 0, z: 0 }, { x: 12, z: 0 }],
      1,
    );
    expect(box?.minX).toBe(-6);
    expect(box!.minX + box!.width).toBe(13);
  });

  it('frames a schematic floor from space outlines alone', () => {
    const box = plateBounds({ spaces: [[[0, 0], [4, 0], [4, 3], [0, 3]]] }, [], 0.5);
    expect(box).toEqual({ minX: -0.5, minZ: -0.5, width: 5, height: 4 });
  });

  it('includes plan room rectangles', () => {
    const box = plateBounds({ rooms: [{ x0: -2, z0: -2, x1: 6, z1: 3 }] }, [], 0.5);
    expect(box).toEqual({ minX: -2.5, minZ: -2.5, width: 9, height: 6 });
  });

  it('keeps a minimum padding even when asked for none', () => {
    // Deliberate: a route that touches the wall it runs along is unreadable
    // pressed against the frame edge, so 0 is clamped to 0.25m.
    const box = plateBounds({ rooms: [{ x0: 0, z0: 0, x1: 4, z1: 4 }] }, [], 0);
    expect(box).toEqual({ minX: -0.25, minZ: -0.25, width: 4.5, height: 4.5 });
  });

  it('gives a straight corridor real area rather than a zero-height box', () => {
    const box = plateBounds({}, [{ x: 0, z: 0 }, { x: 10, z: 0 }], 0);
    expect(box!.height).toBeGreaterThan(0);
    expect(box!.width).toBe(10.5); // 10m of corridor + the 0.25m padding floor
  });

  it('returns null when there is nothing to draw', () => {
    expect(plateBounds({}, [])).toBeNull();
    expect(plateBounds({ walls: [], spaces: [], rooms: [] }, [])).toBeNull();
  });

  it('ignores non-finite junk rather than producing NaN bounds', () => {
    const box = plateBounds(
      { walls: [[[0, 0], [Number.NaN, 5], [4, 4]]] },
      [{ x: Infinity, z: 0 }],
      0.5,
    );
    // The NaN vertex and the Infinity route point are dropped, not propagated.
    expect(box).toEqual({ minX: -0.5, minZ: -0.5, width: 5, height: 5 });
  });
});

describe('polylinePath', () => {
  it('emits a move then lines', () => {
    // 1.256 -> 1.26: two decimals is ~1cm at building scale, below a stroke width.
    expect(polylinePath([{ x: 0, z: 0 }, { x: 1.256, z: 2 }])).toBe('M 0 0 L 1.26 2');
  });

  it('refuses a degenerate line — one point is not a route', () => {
    expect(polylinePath([{ x: 1, z: 1 }])).toBeNull();
    expect(polylinePath([])).toBeNull();
  });

  it('drops non-finite points instead of emitting NaN into the path', () => {
    expect(polylinePath([{ x: 0, z: 0 }, { x: Number.NaN, z: 1 }, { x: 2, z: 2 }])).toBe(
      'M 0 0 L 2 2',
    );
  });
});

describe('polygonPath', () => {
  it('closes the ring', () => {
    expect(polygonPath([[0, 0], [2, 0], [2, 2]])).toBe('M 0 0 L 2 0 L 2 2 Z');
  });

  it('refuses anything that cannot enclose area', () => {
    expect(polygonPath([[0, 0], [1, 1]])).toBeNull();
    expect(polygonPath([])).toBeNull();
  });
});
