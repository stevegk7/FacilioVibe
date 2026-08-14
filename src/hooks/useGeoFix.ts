// Lifted from asset-lens src/hooks/useGeoFix.ts. Warm geolocation watch:
// starts when mounted/enabled, keeps the latest fix in a REF (never state —
// a 1Hz GPS stream must not re-render an AR screen), sampled on demand.
// Indoors the fix is often stale/absent; callers treat null as normal.
import { useCallback, useEffect, useRef } from 'react';
import { isMockMode } from '../api/provider';
import type { GeoFix } from '../api/types';

/** Fixed fixture substituted in ?mock=1 (matches the mock org's campus). */
export const MOCK_GEO_FIX: Omit<GeoFix, 'at'> = { lat: 12.97212, lng: 77.59369, accuracy: 8 };

/** Freshness window — a fix older than this reads as "no fix". */
const MAX_AGE_MS = 60_000;

export type GetFix = () => GeoFix | null;

export function useGeoFix(enabled: boolean): GetFix {
  const fixRef = useRef<GeoFix | null>(null);

  useEffect(() => {
    if (!enabled || isMockMode() || !('geolocation' in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const fix: GeoFix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          at: Date.now(),
        };
        // Keep the BEST fresh fix, not the latest: indoors the stream
        // oscillates (15m … 65m …) and a survey stamped with whichever
        // reading happened to be last would carry the junk one forever.
        const held = fixRef.current;
        if (!held || fix.accuracy <= held.accuracy || Date.now() - held.at > MAX_AGE_MS) {
          fixRef.current = fix;
        }
      },
      () => {
        /* denied/unavailable — fix stays null, which is a normal answer indoors */
      },
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  /** Latest fix if fresh enough (≤60s), else null. */
  return useCallback(() => {
    if (!enabled) return null;
    if (isMockMode()) return { ...MOCK_GEO_FIX, at: Date.now() };
    const fix = fixRef.current;
    return fix && Date.now() - fix.at <= MAX_AGE_MS ? fix : null;
  }, [enabled]);
}
