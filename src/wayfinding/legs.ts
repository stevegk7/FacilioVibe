// Indoor wayfinding legs: standpoint-to-standpoint over each survey's
// geolocation. The last metres (in-room) are never a leg — that is ArGuide's
// job once the walker scans/relocalizes at the target standpoint.
import type { Survey } from '../api/types';
import { compassWord } from './bearing';
import { haversineMeters, initialBearingDeg } from './geo';

export interface WayLeg {
  toSurveyId: string;
  toName: string;
  distanceM: number;
  bearingDeg: number;
  /** 'Head to WS-02 — 40m northeast' */
  text: string;
}

export function legText(name: string, distanceM: number, bearingDeg: number): string {
  return `Head to ${name} — ${Math.round(distanceM)}m ${compassWord(bearingDeg)}`;
}

/** Minimum progress (m) a waypoint must make toward the target to earn a leg. */
const MIN_PROGRESS_M = 5;

/**
 * Ordered leg list from a start point to a target survey's standpoint.
 * Greedy chain over GEOTAGGED standpoints only: each hop must move closer to
 * the target (so the list never ping-pongs), untagged surveys are simply not
 * routable waypoints. Returns [] when the target has no geotag — the caller
 * must refuse with an explanatory hint instead of guessing.
 */
export function indoorLegs(
  surveys: Survey[],
  from: { lat: number; lng: number } | null,
  targetSurveyId: string,
): WayLeg[] {
  const target = surveys.find((s) => s.id === targetSurveyId);
  if (!target?.geo || !from) return [];

  const waypoints = surveys.filter((s) => s.geo && s.id !== targetSurveyId);
  const remaining = new Set(waypoints);
  const legs: WayLeg[] = [];
  let cur = { lat: from.lat, lng: from.lng };

  // Bounded: each iteration consumes a waypoint or exits to the final leg.
  for (let guard = 0; guard < 12; guard++) {
    const dTarget = haversineMeters(cur, target.geo);
    let next: Survey | null = null;
    let bestD = Infinity;
    for (const s of remaining) {
      const g = s.geo as NonNullable<Survey['geo']>;
      const dToS = haversineMeters(cur, g);
      const sToTarget = haversineMeters(g, target.geo);
      // must make real progress and not be the spot we are standing on
      if (sToTarget < dTarget - MIN_PROGRESS_M && dToS > 1 && dToS < bestD) {
        next = s;
        bestD = dToS;
      }
    }
    if (!next) break;
    remaining.delete(next);
    const g = next.geo as NonNullable<Survey['geo']>;
    const dist = haversineMeters(cur, g);
    const bearing = initialBearingDeg(cur, g);
    legs.push({
      toSurveyId: next.id,
      toName: next.name,
      distanceM: dist,
      bearingDeg: bearing,
      text: legText(next.name, dist, bearing),
    });
    cur = { lat: g.lat, lng: g.lng };
  }

  const dist = haversineMeters(cur, target.geo);
  const bearing = initialBearingDeg(cur, target.geo);
  legs.push({
    toSurveyId: target.id,
    toName: target.name,
    distanceM: dist,
    bearingDeg: bearing,
    text: legText(target.name, dist, bearing),
  });
  return legs;
}

/**
 * Outdoor fallback deep link. Opened with window.open — the google-maps
 * connection is NOT wired yet.
 * TODO(google-maps): once the connection exists, swap callers to the
 * get-directions action instead of this URL.
 */
export function mapsDirectionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}
