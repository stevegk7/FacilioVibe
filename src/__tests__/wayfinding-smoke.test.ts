// WS-B acceptance: the wayfinding maths a walking technician depends on.
// Pure functions only — no DOM, no sensors.
import { describe, expect, it } from 'vitest';
import { bearingToCaption, compassWord, wrap } from '../wayfinding/bearing';
import { haversineMeters, shortlist, type GeoItem } from '../wayfinding/geo';
import { indoorLegs, mapsDirectionsUrl } from '../wayfinding/legs';
import type { GeoFix, Survey } from '../api/types';

const M_PER_DEG_LAT = 111_320;
const BASE = { lat: 12.97, lng: 77.59 };
/** `metres` north of BASE. */
function north(metres: number) {
  return { lat: BASE.lat + metres / M_PER_DEG_LAT, lng: BASE.lng };
}

function survey(id: string, geo: { lat: number; lng: number } | null): Survey {
  return {
    id,
    name: id.toUpperCase(),
    geo: geo ? { ...geo, accuracy: 8, at: Date.now() } : null,
    sweep: [],
    markers: [],
    modelId: 'luma64-v0',
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('bearingToCaption', () => {
  it.each([
    [0, 'straight ahead'],
    [7.9, 'straight ahead'],
    [-7.9, 'straight ahead'],
    [8.1, '8° right'],
    [-45, '45° left'],
    [90, '90° right'],
    [179, 'behind you'],
    [-179, 'behind you'],
  ])('%s° → %s', (delta, phrase) => {
    expect(bearingToCaption(delta)).toBe(phrase);
  });

  it('reads through the ±180 seam', () => {
    // 350° target while facing 10° is 20° to the LEFT, never 340° right
    expect(bearingToCaption(350 - 10 - 360)).toBe('20° left');
  });
});

describe('wrap', () => {
  it.each([
    [0, 0],
    [10, 10],
    [-10, -10],
    [180, -180],
    [190, -170],
    [-190, 170],
    [360, 0],
    [370, 10],
    [-370, -10],
  ])('wrap(%s) === %s', (input, expected) => {
    expect(wrap(input)).toBe(expected);
  });

  it('compass words follow the 8-way rose', () => {
    expect(compassWord(0)).toBe('north');
    expect(compassWord(46)).toBe('northeast');
    expect(compassWord(359)).toBe('north');
    expect(compassWord(225)).toBe('southwest');
  });
});

describe('indoorLegs', () => {
  const ws01 = survey('ws-01', north(50));
  const ws02 = survey('ws-02', north(100));
  const untagged = survey('ws-03', null);
  const surveys = [ws01, ws02, untagged];

  it('chains two geotagged standpoints from a start point', () => {
    const legs = indoorLegs(surveys, BASE, 'ws-02');
    expect(legs.map((l) => l.toSurveyId)).toEqual(['ws-01', 'ws-02']);
    expect(Math.round(legs[0].distanceM)).toBe(50);
    expect(Math.round(legs[1].distanceM)).toBe(50);
    expect(legs[0].bearingDeg).toBeCloseTo(0, 1);
    expect(legs[0].text).toBe('Head to WS-01 — 50m north');
  });

  it('never routes through an untagged standpoint, and stops at the target', () => {
    const legs = indoorLegs(surveys, north(60), 'ws-02');
    expect(legs).toHaveLength(1); // ws-01 is BEHIND us — no ping-pong
    expect(legs[0].toSurveyId).toBe('ws-02');
    expect(legs.some((l) => l.toSurveyId === 'ws-03')).toBe(false);
  });

  it('refuses (empty list) when the target has no geotag or we have no fix', () => {
    expect(indoorLegs(surveys, BASE, 'ws-03')).toEqual([]);
    expect(indoorLegs(surveys, null, 'ws-02')).toEqual([]);
  });

  it('the outdoor fallback is a plain maps deep link, not a connection action', () => {
    expect(mapsDirectionsUrl(12.5, 77.25)).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=12.5,77.25',
    );
  });

  it('haversine agrees with the metre offsets used above', () => {
    expect(haversineMeters(BASE, north(100))).toBeCloseTo(100, 0);
  });
});

describe('shortlist (shrink-only invariant)', () => {
  const fix: GeoFix = { ...BASE, accuracy: 10, at: Date.now() };
  const items: GeoItem[] = [
    { id: 'near-1', geo: { ...north(10), accuracy: 10 }, buildingId: 1 },
    { id: 'near-2', geo: { ...north(20), accuracy: 10 }, buildingId: 1 },
    { id: 'near-3', geo: { ...north(30), accuracy: 10 }, buildingId: 1 },
    { id: 'near-4', geo: { ...north(40), accuracy: 10 }, buildingId: 1 },
    { id: 'far-1', geo: { ...north(4000), accuracy: 10 }, buildingId: 2 },
    { id: 'far-2', geo: { ...north(5000), accuracy: 10 }, buildingId: 2 },
    { id: 'untagged', geo: null, buildingId: 2 },
  ];

  it('shrinks to the radius but ALWAYS keeps untagged items', () => {
    const list = shortlist(items, fix);
    expect(list.scope).toBe('radius');
    expect(list.ids.has('near-1')).toBe(true);
    expect(list.ids.has('far-1')).toBe(false);
    // the load-bearing invariant: no geotag is never a reason to be excluded
    expect(list.ids.has('untagged')).toBe(true);
    expect(list.ids.size).toBeLessThan(items.length);
  });

  it('no fix → everything survives (geo may only shrink, never invent)', () => {
    const list = shortlist(items, null);
    expect(list.scope).toBe('site');
    expect(list.ids.size).toBe(items.length);
  });

  it('a shortlist is always a subset of the input', () => {
    const all = new Set(items.map((i) => i.id));
    for (const f of [null, fix, { ...fix, accuracy: 900 }]) {
      for (const id of shortlist(items, f).ids) expect(all.has(id)).toBe(true);
    }
  });
});
