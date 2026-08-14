// Lifted from asset-lens src/domain/geo.ts (haversine + shrink-only
// shortlist), generalized over any geotaggable item and extended with the
// initial-bearing helper the leg planner needs.
import type { GeoFix } from '../api/types';

const R = 6371000;

export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Great-circle initial bearing a → b, degrees 0-360 (0 = north). */
export function initialBearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lb);
  const x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export interface GeoItem {
  id: number | string;
  geo: { lat: number; lng: number; accuracy: number } | null;
  buildingId?: number;
}

export interface Shortlist {
  ids: Set<number | string>;
  scope: 'radius' | 'building' | 'site';
}

/**
 * Geo candidate scoping. INVARIANT: geo may only SHRINK the candidate set
 * among GEOTAGGED items — items with no geotag are ALWAYS included (indoor
 * captures often have no fix). Ladder: radius → nearest building → site.
 * Adaptive radius: max(75, 2 * (fix.accuracy + item.accuracy)).
 */
export function shortlist(items: GeoItem[], fix: GeoFix | null): Shortlist {
  const all = new Set(items.map((a) => a.id));
  if (!fix) return { ids: all, scope: 'site' };

  const inRadius = new Set<number | string>();
  let nearest: { row: GeoItem; d: number } | null = null;
  for (const a of items) {
    if (!a.geo) {
      inRadius.add(a.id);
      continue;
    }
    const d = haversineMeters(fix, a.geo);
    if (!nearest || d < nearest.d) nearest = { row: a, d };
    const limit = Math.max(75, 2 * (fix.accuracy + a.geo.accuracy));
    if (d <= limit) inRadius.add(a.id);
  }
  const geotagged = items.filter((a) => a.geo).length;
  if (geotagged > 0 && inRadius.size >= Math.min(5, all.size)) {
    return { ids: inRadius, scope: 'radius' };
  }

  if (nearest?.row.buildingId) {
    const b = nearest.row.buildingId;
    const inBuilding = new Set(items.filter((a) => !a.geo || a.buildingId === b).map((a) => a.id));
    if (inBuilding.size >= Math.min(5, all.size)) return { ids: inBuilding, scope: 'building' };
  }
  return { ids: all, scope: 'site' };
}
