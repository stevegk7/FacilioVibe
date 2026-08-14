// Regression: with no compass every marker was written with heading 0, so
// notes stacked on ONE point in the AR view — and were saved that way. A
// bearing that looks placed but isn't is worse than admitting we don't know.
import { describe, expect, it } from 'vitest';
import { draftBearing, MANUAL_SPREAD_DEG } from '../wayfinding/bearingDraft';

describe('draftBearing', () => {
  it('captures the aimed direction relative to sweep frame 0', () => {
    expect(draftBearing({ heading: 137, sweepBase: 100, markerCount: 0 })).toEqual({
      rel: 37,
      bearingKnown: true,
    });
  });

  it('wraps correctly when the aim crosses north', () => {
    expect(draftBearing({ heading: 10, sweepBase: 350, markerCount: 3 }).rel).toBe(20);
    expect(draftBearing({ heading: 350, sweepBase: 10, markerCount: 0 }).rel).toBe(340);
  });

  it('NEVER reports a known bearing when the compass is silent', () => {
    const draft = draftBearing({ heading: null, sweepBase: 0, markerCount: 0 });
    expect(draft.bearingKnown).toBe(false);
  });

  it('spreads hand-placed markers so they cannot stack on one point', () => {
    const bearings = [0, 1, 2, 3].map(
      (n) => draftBearing({ heading: null, sweepBase: 0, markerCount: n }).rel,
    );
    expect(new Set(bearings).size).toBe(bearings.length);
    expect(bearings[1] - bearings[0]).toBe(MANUAL_SPREAD_DEG);
  });

  it('a real aim of 0° is still a KNOWN bearing — 0 is a direction, not a failure', () => {
    const draft = draftBearing({ heading: 0, sweepBase: 0, markerCount: 5 });
    expect(draft).toEqual({ rel: 0, bearingKnown: true });
  });
});

describe('placement reading', () => {
  it('takes the circular median so an outlier at the tap cannot be written forever', async () => {
    const { setOrientationForTest, placementOrientation } = await import('../hooks/useHeading');
    // a run of steady readings with one wild sample in the middle
    for (const h of [10, 11, 10, 190, 11, 10]) setOrientationForTest(h, 0);
    const reading = placementOrientation();
    expect(reading).not.toBeNull();
    // the 190° spike must not drag the answer away from ~10°
    const d = Math.abs(((reading!.heading - 10 + 540) % 360) - 180);
    expect(d).toBeLessThan(20);
  });

  it('wraps correctly around north (359 and 1 average to ~0, not ~180)', async () => {
    const { setOrientationForTest, placementOrientation } = await import('../hooks/useHeading');
    for (const h of [359, 1, 0, 358, 2]) setOrientationForTest(h, 0);
    const reading = placementOrientation();
    const d = Math.abs(((reading!.heading - 0 + 540) % 360) - 180);
    expect(d).toBeLessThan(15);
  });
});
