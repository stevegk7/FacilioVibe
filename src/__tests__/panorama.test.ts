// Projecting markers back onto the sweep photos. Pure geometry, because the
// failure mode is silent: a marker drawn on the wrong frame, or at the wrong
// height, still looks perfectly plausible.
import { describe, expect, it } from 'vitest';
import { FRAME_FOV_X, markerBearing, markersByFrame, projectMarker, viewableFrames } from '../ar/panorama';
import type { Survey, SurveyMarker, SweepFrame } from '../api/types';

const vec = { q: '', s: 1, dim: 1 };
const frame = (heading: number, fileId?: number, pitch = 0): SweepFrame => ({
  heading,
  pitch,
  vec,
  fileId,
});
const marker = (id: string, heading: number, pitch = 0, assetId?: number): SurveyMarker => ({
  id,
  label: id,
  heading,
  pitch,
  assetId,
});

function survey(sweep: SweepFrame[], markers: SurveyMarker[]): Survey {
  return {
    id: 's1',
    name: 'Plant room',
    geo: null,
    sweep,
    markers,
    modelId: 'test',
    createdAt: '2026-01-01',
  };
}

describe('projectMarker', () => {
  it('puts a marker dead centre when it is straight ahead of the frame', () => {
    // sweep base 100°, marker +0° => absolute 100°, frame also at 100°
    const s = survey([frame(100)], [marker('m', 0)]);
    const hit = projectMarker(s, s.sweep[0], s.markers[0]);
    expect(hit?.x).toBeCloseTo(0.5, 3);
    expect(hit?.y).toBeCloseTo(0.5, 3);
  });

  it('places a marker to the RIGHT when its bearing is clockwise of the frame', () => {
    const s = survey([frame(100)], [marker('m', 20)]); // absolute 120°
    const hit = projectMarker(s, s.sweep[0], s.markers[0]);
    expect(hit!.x).toBeGreaterThan(0.5);
  });

  it('puts a marker ABOVE centre when it was placed looking up', () => {
    // screen y grows downward, so a positive pitch must reduce y
    const s = survey([frame(100)], [marker('m', 0, 15)]);
    expect(projectMarker(s, s.sweep[0], s.markers[0])!.y).toBeLessThan(0.5);
  });

  it('returns null outside the frame, in either axis', () => {
    const s = survey([frame(100)], [marker('wide', FRAME_FOV_X), marker('high', 0, 40)]);
    expect(projectMarker(s, s.sweep[0], s.markers[0])).toBeNull();
    expect(projectMarker(s, s.sweep[0], s.markers[1])).toBeNull();
  });

  it('wraps across north instead of hiding the marker', () => {
    const s = survey([frame(350)], [marker('m', 15)]); // base 350 + 15 = 5°
    const hit = projectMarker(s, s.sweep[0], s.markers[0]);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeGreaterThan(0.5); // 15° clockwise of the frame
  });
});

describe('markersByFrame', () => {
  it('draws an overlapping marker ONCE, on the frame it is most centred in', () => {
    // frames 28° apart, marker at absolute 114° — visible on both, closest to 114
    const s = survey([frame(100, 1), frame(128, 2)], [marker('m', 14)]);
    const byFrame = markersByFrame(s);
    const drawn = byFrame.flat();
    expect(drawn).toHaveLength(1);
    // 114 is 14° from frame0 and 14° from frame1 — ties resolve to the first
    expect(byFrame[0]).toHaveLength(1);
  });

  it('assigns each marker to its own best frame', () => {
    const s = survey(
      [frame(0, 1), frame(90, 2)],
      [marker('near-zero', 5), marker('near-ninety', 88)],
    );
    const byFrame = markersByFrame(s);
    expect(byFrame[0].map((h) => h.marker.id)).toEqual(['near-zero']);
    expect(byFrame[1].map((h) => h.marker.id)).toEqual(['near-ninety']);
  });
});

describe('viewableFrames', () => {
  it('only offers frames that actually kept a photo', () => {
    const s = survey([frame(0, 11), frame(30), frame(60, 12)], []);
    expect(viewableFrames(s).map((f) => f.frame.fileId)).toEqual([11, 12]);
  });

  it('a survey captured before photos were kept shows nothing rather than breaking', () => {
    const s = survey([frame(0), frame(30)], [marker('m', 0)]);
    expect(viewableFrames(s)).toEqual([]);
  });
});

describe('markerBearing', () => {
  it('is the same rule the AR view renders by', () => {
    const s = survey([frame(100)], [marker('m', 30)]);
    expect(markerBearing(s, s.markers[0])).toBe(130);
  });
});
