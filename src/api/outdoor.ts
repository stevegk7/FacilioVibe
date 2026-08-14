/**
 * Outdoor legs — the Google Maps side of wayfinding.
 *
 * Two lanes, honest about which one you're on:
 *  - A deep link (mapsDirectionsUrl) always works and needs no authorization.
 *  - The google-maps-routes connection, once the org has linked it, returns a
 *    real walking route with distance, duration and turn instructions. We
 *    probe it at most once per session; "not ACTIVE" is a normal answer, not
 *    an error, and the UI quietly stays on deep links until the link lands.
 *
 * Mock mode never calls out: a canned route keeps ?mock=1 walkable offline.
 */
import { isMockMode } from './provider';
import { execute } from './facilioHelpers';

export interface OutdoorRoute {
  distanceM: number;
  durationS: number;
  steps: string[];
}

interface ComputeRouteResponse {
  routes?: Array<{
    distance_meters?: number;
    duration?: string; // "165s"
    encoded_polyline?: string;
    steps?: Array<{ instruction?: string }>;
  }>;
}

/** null = not linked / failed — caller falls back to the deep link. */
let linkedProbe: Promise<boolean> | null = null;

async function probeLinked(): Promise<boolean> {
  try {
    // A degenerate same-point route is the cheapest truthful probe: it either
    // answers (linked) or throws "not ACTIVE" (not linked).
    await execute('google-maps-routes', 'compute-route', {
      origin_address: '0,0',
      destination_address: '0,0',
      travelMode: 'WALK',
    });
    return true;
  } catch (err) {
    // "not ACTIVE" is the expected unlinked answer; anything else is equally
    // a reason to stay on deep links this session.
    void err;
    return false;
  }
}

export function outdoorRoutingLinked(): Promise<boolean> {
  if (isMockMode()) return Promise.resolve(true);
  linkedProbe ??= probeLinked();
  return linkedProbe;
}

export async function computeOutdoorRoute(
  origin: { lat: number; lng: number } | string,
  destination: { lat: number; lng: number } | string,
): Promise<OutdoorRoute | null> {
  if (isMockMode()) {
    return { distanceM: 420, durationS: 360, steps: ['Head north on the service road', 'The destination site is on your right'] };
  }
  if (!(await outdoorRoutingLinked())) return null;
  const addr = (p: { lat: number; lng: number } | string) =>
    typeof p === 'string' ? p : `${p.lat},${p.lng}`;
  try {
    const res = await execute<never>('google-maps-routes', 'compute-route', {
      origin_address: addr(origin),
      destination_address: addr(destination),
      travelMode: 'WALK',
      routingPreference: 'TRAFFIC_UNAWARE',
    });
    const route = (res as ComputeRouteResponse).routes?.[0];
    if (!route) return null;
    return {
      distanceM: route.distance_meters ?? 0,
      durationS: parseInt(String(route.duration ?? '0'), 10) || 0,
      steps: (route.steps ?? []).map((s) => s.instruction ?? '').filter(Boolean),
    };
  } catch {
    // Linked but the call failed (quota, transient): the deep link still works.
    return null;
  }
}
