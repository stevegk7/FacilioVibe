/**
 * Route legs -> engine drawing spec.
 *
 * routeOnGraph phrases a journey; the 3D engine only draws polylines. This is
 * the seam between them, kept pure so a route can be re-drawn (floor switch,
 * theme change) without re-routing.
 *
 * Vertical legs draw NOTHING: a stair core is one synthetic point, and a line
 * from "somewhere on L1" to "the same x/z on L3" would be a lie in both
 * frames — the step strip narrates the climb instead. Indoor legs stay in
 * their floor-local frame (the engine offsets per plate), outdoor legs stay in
 * world metres.
 */
import type { AutoLeg } from './autoGraph';

export interface RouteDrawLeg {
  kind: 'indoor' | 'outdoor';
  /** Engine building key — a STRING (EstateBuilding.id), not the record id. */
  buildingId?: string;
  floorId?: number;
  points: Array<{ x: number; z: number }>;
}

const finitePoint = (p: unknown): p is { x: number; z: number } =>
  typeof p === 'object' &&
  p != null &&
  Number.isFinite((p as { x?: unknown }).x) &&
  Number.isFinite((p as { z?: unknown }).z);

/**
 * Never throws — legs come from a graph that may carry a stale overlay, so a
 * malformed or degenerate (< 2 points) leg is skipped, not fatal. Drawing
 * less than the route is recoverable; crashing the scene is not.
 */
export function legsToRouteSpec(legs: AutoLeg[]): RouteDrawLeg[] {
  const spec: RouteDrawLeg[] = [];
  if (!Array.isArray(legs)) return spec;

  for (const leg of legs) {
    if (leg == null || typeof leg !== 'object') continue;
    if (leg.kind !== 'indoor' && leg.kind !== 'outdoor') continue;
    const points = Array.isArray(leg.points) ? leg.points.filter(finitePoint) : [];
    if (points.length < 2) continue;

    spec.push({
      kind: leg.kind,
      ...(leg.kind === 'indoor' && leg.buildingId != null
        ? { buildingId: String(leg.buildingId) }
        : {}),
      ...(leg.kind === 'indoor' && leg.floorId != null ? { floorId: leg.floorId } : {}),
      points: points.map((p) => ({ x: p.x, z: p.z })),
    });
  }
  return spec;
}
