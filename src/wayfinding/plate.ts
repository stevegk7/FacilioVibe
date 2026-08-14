/**
 * Framing a floor plate — the pure half of the 2D route view.
 *
 * The research the route surface is built on is blunt that 3D is the wrong
 * surface to ROUTE on: it measurably increases cognitive load through
 * information overload, and helps only users with low spatial ability. Even a
 * 3D-first vendor falls back to semi-3D on a phone. So the route is drawn on a
 * flat per-floor plate, and the 3D estate keeps the jobs it is genuinely good
 * at — portfolio overview and showing where a thing sits in a building.
 *
 * Everything below is in the estate's FLOOR-LOCAL METRE frame: origin at the
 * plate centre, +x right, and +z is the CAD drawing's "down" (it comes straight
 * from SVG y during extraction). That last fact is the one that makes this
 * cheap: a plate can map z to SVG y directly, with no flip, and the drawing
 * comes out the way the architect drew it.
 */

export interface PlateBox {
  minX: number;
  minZ: number;
  width: number;
  height: number;
}

/** A rectangle from a plan room, in floor-local metres. */
export interface PlateRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface PlateGeometry {
  /** Wall polylines from a bound CAD plan; absent on a schematic floor. */
  walls?: number[][][];
  /** Room rectangles from a bound plan. */
  rooms?: PlateRect[];
  /** Space outlines — the only geometry a floor without a plan has. */
  spaces?: number[][][];
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * The viewBox that contains the floor AND the whole route.
 *
 * Unioned rather than taken from the floor alone, because a route can legitimately
 * leave the drawn geometry: a leg ends at a stair core or a building door that the
 * plan does not cover, and clipping the last segment is exactly the moment a
 * technician stops trusting the picture.
 *
 * Returns null when there is nothing real to draw — an empty box would render as
 * a divide-by-zero smear, and the caller should show nothing at all instead.
 */
export function plateBounds(
  geometry: PlateGeometry,
  route: Array<{ x: number; z: number }> = [],
  paddingM = 1.5,
): PlateBox | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let seen = false;

  const take = (x: unknown, z: unknown) => {
    if (!finite(x) || !finite(z)) return;
    seen = true;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };

  for (const line of geometry.walls ?? []) for (const p of line ?? []) take(p?.[0], p?.[1]);
  for (const line of geometry.spaces ?? []) for (const p of line ?? []) take(p?.[0], p?.[1]);
  for (const r of geometry.rooms ?? []) {
    take(r?.x0, r?.z0);
    take(r?.x1, r?.z1);
  }
  for (const p of route) take(p?.x, p?.z);

  if (!seen) return null;

  // A degenerate extent (one point, or a perfectly straight corridor) still has
  // to produce a box with area, or the SVG scales to infinity.
  const pad = Math.max(0.25, paddingM);
  const width = Math.max(maxX - minX, 0.5) + pad * 2;
  const height = Math.max(maxZ - minZ, 0.5) + pad * 2;
  return {
    minX: minX - pad,
    minZ: minZ - pad,
    width,
    height,
  };
}

/** `points` as an SVG path `d`, or null when there is nothing to draw. */
export function polylinePath(points: Array<{ x: number; z: number }>): string | null {
  const usable = points.filter((p) => finite(p?.x) && finite(p?.z));
  if (usable.length < 2) return null;
  return usable
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)} ${round(p.z)}`)
    .join(' ');
}

/** Closed path for a polygon ring. Null unless it has real area to enclose. */
export function polygonPath(ring: number[][]): string | null {
  const usable = (ring ?? []).filter((p) => finite(p?.[0]) && finite(p?.[1]));
  if (usable.length < 3) return null;
  return `${usable.map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p[0])} ${round(p[1])}`).join(' ')} Z`;
}

/** Two decimals is ~1cm at building scale — far below a stroke width. */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
