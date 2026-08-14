// The three accuracy loops: image-shift measurement, FOV self-calibration,
// and sub-frame visual Δ — plus the step detector that keeps walking honest.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_BINS, profileShift, shiftDegrees } from '../ar/imageShift';
import { __resetFovCalForTest, isCalibrated, longAxisFovDeg, observeCalSample } from '../ar/fovCal';
import { __feedMotionForTest, __resetMovementForTest, resetSteps, stepsSince } from '../ar/movement';
import { Relocalizer } from '../ar/relocalize';
import { quantizeInt8 } from '../vision/quantize';
import type { Survey } from '../api/types';

/** A structured synthetic profile (zero-mean-ish sine mix — unambiguous peak). */
function syntheticProfile(phase = 0): Float32Array {
  const p = new Float32Array(PROFILE_BINS);
  for (let i = 0; i < PROFILE_BINS; i++) {
    p[i] =
      12 * Math.sin(((i + phase) / PROFILE_BINS) * Math.PI * 2) +
      7 * Math.sin(((i + phase) / PROFILE_BINS) * Math.PI * 6 + 1) +
      4 * Math.sin(((i + phase) / PROFILE_BINS) * Math.PI * 14 + 2);
  }
  return p;
}

describe('profileShift', () => {
  it('recovers a known displacement with sub-bin precision', () => {
    // content moved 5 bins right
    const a = syntheticProfile(0);
    const b = syntheticProfile(-5);
    const s = profileShift(a, b)!;
    expect(s.shiftBins).toBeCloseTo(5, 0);
    expect(s.confidence).toBeGreaterThan(0.8);
  });

  it('a flat frame (blank wall) cannot vote', () => {
    expect(profileShift(new Float32Array(PROFILE_BINS), syntheticProfile())).toBeNull();
  });

  it('shiftDegrees maps bins through the capture FOV', () => {
    expect(shiftDegrees(PROFILE_BINS / 2, 40)).toBeCloseTo(20, 6);
  });
});

describe('FOV self-calibration', () => {
  beforeEach(__resetFovCalForTest);
  afterEach(__resetFovCalForTest);

  it('converges to the true focal length from gyro-vs-image pairs', () => {
    // Simulate a camera whose TRUE capture hFOV is 40°: f_bins = (B/2)/tan(20°)
    const RAD = Math.PI / 180;
    const fBins = PROFILE_BINS / 2 / Math.tan(20 * RAD);
    for (let i = 0; i < 40 && !isCalibrated(); i++) {
      const stepDeg = 2 + (i % 5); // 2..6° gentle pans
      const shift = fBins * Math.tan(stepDeg * RAD); // exact pinhole shift
      observeCalSample({
        prev: syntheticProfile(0),
        next: syntheticProfile(shift), // pan right → content moves LEFT by `shift` bins
        dHeadingDeg: stepDeg,
        dPitchDeg: 0,
        frameW: 480,
        frameH: 640, // portrait: long axis = height
      });
    }
    expect(isCalibrated()).toBe(true);
    // hFOV 40° at aspect 480x640 → long-axis: 2·atan(tan(20°)·(640/480)) ≈ 51.8°
    expect(longAxisFovDeg(68)).toBeGreaterThan(48);
    expect(longAxisFovDeg(68)).toBeLessThan(56);
  });

  it('rejects pairs where image motion agrees in SIGN with the pan (not rotation)', () => {
    observeCalSample({
      prev: syntheticProfile(0),
      next: syntheticProfile(-5), // content moved RIGHT while panning right — bogus
      dHeadingDeg: 4,
      dPitchDeg: 0,
      frameW: 480,
      frameH: 640,
    });
    expect(isCalibrated()).toBe(false);
    expect(longAxisFovDeg(68)).toBe(68); // fallback untouched
  });
});

describe('sub-frame visual Δ', () => {
  const mkSurvey = (profile: number[] | undefined): Survey => ({
    id: 'sv-fine',
    name: 'Fine',
    geo: null,
    sweep: [
      {
        heading: 100,
        pitch: 0,
        vec: quantizeInt8(Float32Array.from({ length: 16 }, (_, i) => Math.sin(i))),
        profile,
      },
    ],
    markers: [],
    modelId: 'luma64-v0',
    createdAt: '2026-08-01T00:00:00.000Z',
  });

  const liveVec = Float32Array.from({ length: 16 }, (_, i) => Math.sin(i));

  it('refines Δ by the measured within-frame rotation', () => {
    const stored = syntheticProfile(0);
    const reloc = new Relocalizer();
    reloc.load([mkSurvey(Array.from(stored))], 'luma64-v0');

    // The device is REALLY looking 5 bins right of the stored frame. With a
    // 40° capture FOV that is 3.125°. Compass reads 110 (its own frame).
    const live = { profile: syntheticProfile(5), hFovDeg: 40 };
    let cur = reloc.observe(liveVec, 110, live);
    cur = reloc.observe(liveVec, 110, live); // 2-match activation rule
    // coarse would say Δ = 110-100 = 10; fine knows the view is 3.125° past
    // the frame, so Δ = 110 - 103.125 ≈ 6.9
    expect(cur!.delta).toBeGreaterThan(5.5);
    expect(cur!.delta).toBeLessThan(8);
  });

  it('falls back to the coarse frame Δ when the survey predates profiles', () => {
    const reloc = new Relocalizer();
    reloc.load([mkSurvey(undefined)], 'luma64-v0');
    const live = { profile: syntheticProfile(5), hFovDeg: 40 };
    let cur = reloc.observe(liveVec, 110, live);
    cur = reloc.observe(liveVec, 110, live);
    expect(cur!.delta).toBe(10);
  });
});

describe('step detector', () => {
  beforeEach(__resetMovementForTest);

  const still = () => __feedMotionForTest(0, 0, 9.81);
  const impact = () => __feedMotionForTest(0, 0, 13.5);

  it('pulses inside the refractory window collapse into one step', () => {
    resetSteps();
    for (let step = 0; step < 5; step++) {
      for (let i = 0; i < 6; i++) still();
      impact();
      impact(); // the same pulse sampled twice must not double-count
    }
    // all five bursts land within one refractory window (test runs in <1ms)
    expect(stepsSince()).toBe(1);
  });

  it('a walking pattern spaced in time counts each step once', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    resetSteps();
    for (let step = 0; step < 4; step++) {
      for (let i = 0; i < 6; i++) still();
      impact();
      vi.advanceTimersByTime(500);
    }
    expect(stepsSince()).toBe(4);
    vi.useRealTimers();
  });

  it('holding the phone still counts nothing', () => {
    resetSteps();
    for (let i = 0; i < 200; i++) still();
    expect(stepsSince()).toBe(0);
  });
});

describe('walking recalculation (PDR + parallax reprojection)', () => {
  it('dead reckoning accumulates strides along the heading of each step', async () => {
    const { __stepForTest, pdrOffset, resetPdr, STRIDE_M } = await import('../ar/pdr');
    resetPdr();
    __stepForTest(90); // two steps due east
    __stepForTest(90);
    const off = pdrOffset();
    expect(off.x).toBeCloseTo(2 * STRIDE_M, 5);
    expect(off.y).toBeCloseTo(0, 5);
    expect(off.dist).toBeCloseTo(2 * STRIDE_M, 5);
    resetPdr();
    expect(pdrOffset().dist).toBe(0);
  });

  it('reprojects a marker for a viewer who stepped sideways', async () => {
    const { parallaxCorrected } = await import('../ar/presence');
    // marker due north, 4m out; viewer moved 1m east ⇒ the object now lies
    // slightly WEST of north: atan(1/4) ≈ 14° left
    const c = parallaxCorrected(0, 0, 4, { x: 1, y: 0 });
    expect(c.bearing).toBeGreaterThan(345);
    expect(c.bearing).toBeLessThan(347);
  });

  it('walking TOWARD a marker raises its pitch and never explodes at the object', async () => {
    const { parallaxCorrected } = await import('../ar/presence');
    // marker north 3m, slightly above the horizon; viewer walks 2m north
    const c = parallaxCorrected(0, 10, 3, { x: 0, y: 2 });
    expect(c.bearing).toBeCloseTo(0, 5);
    expect(c.pitch).toBeGreaterThan(10); // closer ⇒ steeper look-up
    // standing ON the object: direction is undefined — keep the stored ray
    const on = parallaxCorrected(0, 0, 2, { x: 0, y: 2 });
    expect(on.bearing).toBeCloseTo(0, 5);
  });

  it('a marker BEHIND the walk direction swings to the rear, not to a mirror', async () => {
    const { parallaxCorrected } = await import('../ar/presence');
    // marker north 2m; viewer walks 4m north — the object is now 2m BEHIND
    const c = parallaxCorrected(0, 0, 2, { x: 0, y: 4 });
    expect(Math.abs(((c.bearing - 180 + 540) % 360) - 180)).toBeCloseTo(0, 4);
  });
});
