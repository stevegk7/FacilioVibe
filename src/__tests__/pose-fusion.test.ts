// The two-lane pose filter: the fast lane must be UNSMOOTHED (lag was the
// "pin drags behind the pan" bug), and compass noise must be physically
// unable to wiggle the image (jitter was the "pin swims" bug). These feed the
// real event handlers via the test seam and assert on the public pose.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testFeeds,
  arOrientation,
  arQuaternionAt,
  placementOrientation,
  poseSpeedDegS,
  setOrientationForTest,
} from '../hooks/useHeading';
import { lookPose } from '../ar/fusion';

/** Upright portrait device looking at bearing h: alpha = 360 - h. */
const upright = (h: number) => ({ alpha: (360 - h) % 360, beta: 90, gamma: 0 });

beforeEach(() => {
  vi.useFakeTimers();
  setOrientationForTest(null); // clears every lane
});
afterEach(() => {
  setOrientationForTest(null);
  vi.useRealTimers();
});

describe('fast lane', () => {
  it('tracks the orientation stream with ZERO lag — no EMA, no follower', () => {
    // A 90° pan delivered over 15 events. The pose must land ON the final
    // reading immediately — the old cascade left it ~14° behind.
    for (let i = 0; i <= 15; i++) {
      __testFeeds.orientation(upright(i * 6));
      vi.advanceTimersByTime(16);
    }
    expect(arOrientation().heading).toBeCloseTo(90, 3);
  });

  it('reports pitch and roll-safe headings from all three axes', () => {
    // landscape roll (gamma 90 at beta 0): camera still on the horizon
    __testFeeds.orientation({ alpha: 0, beta: 0, gamma: 90 });
    expect(Math.abs(arOrientation().pitch)).toBeLessThan(1);
  });
});

describe('slow lane (compass anchor)', () => {
  it('iOS: webkitCompassHeading seeds the yaw offset in one sample', () => {
    __testFeeds.orientation({ ...upright(0), webkitCompassHeading: 320 });
    // device top points at 320 → camera looks at 320 (upright portrait)
    expect(arOrientation().heading).toBeCloseTo(320, 1);
    expect(arOrientation().absolute).toBe(true);
  });

  it('compass jitter of ±10° cannot move the pose faster than the slew clamp', () => {
    __testFeeds.orientation({ ...upright(0), webkitCompassHeading: 100 });
    const seeded = arOrientation().heading;
    // 2 seconds of noisy compass while the device is PHYSICALLY STILL
    for (let i = 0; i < 120; i++) {
      const noise = i % 2 === 0 ? 10 : -10;
      __testFeeds.orientation({ ...upright(0), webkitCompassHeading: 100 + noise });
      vi.advanceTimersByTime(16);
    }
    const moved = Math.abs(((arOrientation().heading - seeded + 540) % 360) - 180);
    // slew clamp is 1°/s → 2s of the worst jitter moves the pose ≤ ~2°
    expect(moved).toBeLessThanOrEqual(2.5);
  });

  it('a real bias converges without a visible jump', () => {
    __testFeeds.orientation({ ...upright(0), webkitCompassHeading: 100 });
    // compass now insists on 106° (within the snap threshold) while still
    for (let i = 0; i < 60 * 12; i++) {
      __testFeeds.orientation({ ...upright(0), webkitCompassHeading: 106 });
      vi.advanceTimersByTime(16);
    }
    const h = arOrientation().heading;
    expect(Math.abs(((h - 106 + 540) % 360) - 180)).toBeLessThan(1.5);
  });

  it('Android: the absolute event is only the compass source, never the per-frame pose', () => {
    __testFeeds.orientation(upright(50)); // fast lane present
    __testFeeds.orientationAbsolute(upright(50)); // agrees → offset seeds ~0
    const before = arOrientation().heading;
    // one wild magnetometer spike on the absolute stream
    __testFeeds.orientationAbsolute(upright(80));
    const after = arOrientation().heading;
    expect(Math.abs(((after - before + 540) % 360) - 180)).toBeLessThan(1);
  });

  it('a sustained huge disagreement snaps once instead of crawling', () => {
    __testFeeds.orientation({ ...upright(0), webkitCompassHeading: 0 });
    // compass flips 90° (e.g. walked past a steel column and out again) and
    // STAYS there for over 2 seconds
    for (let i = 0; i < 200; i++) {
      __testFeeds.orientation({ ...upright(0), webkitCompassHeading: 90 });
      vi.advanceTimersByTime(16);
    }
    expect(Math.abs(((arOrientation().heading - 90 + 540) % 360) - 180)).toBeLessThan(2);
  });

  it('no compass at all → pose still works, flagged relative', () => {
    __testFeeds.orientation(upright(210));
    expect(arOrientation().ok).toBe(true);
    expect(arOrientation().heading).toBeCloseTo(210, 2);
    expect(arOrientation().absolute).toBe(false);
  });
});

describe('pose ring (camera-time alignment)', () => {
  it('arQuaternionAt returns the pose as of the requested moment', () => {
    __testFeeds.orientation(upright(0));
    vi.advanceTimersByTime(100);
    __testFeeds.orientation(upright(40));
    // 100ms ago the device pointed at 0°, now at 40°
    const past = arQuaternionAt(Date.now() - 100)!;
    const now = arQuaternionAt(Date.now())!;
    expect(lookPose(past).azimuth).toBeLessThan(10);
    expect(lookPose(now).azimuth).toBeCloseTo(40, 1);
  });
});

describe('speed + placement', () => {
  it('the gyro drives the speed estimate when it speaks', () => {
    __testFeeds.orientation(upright(0));
    for (let i = 0; i < 20; i++) __testFeeds.motion({ rotationRate: { alpha: 0, beta: 0, gamma: 50 } });
    expect(poseSpeedDegS()).toBeGreaterThan(40);
  });

  it('placementOrientation is the median of the recent window, not one instant', () => {
    for (let i = 0; i < 10; i++) {
      __testFeeds.orientation(upright(100));
      vi.advanceTimersByTime(50);
    }
    __testFeeds.orientation(upright(140)); // a last-instant outlier
    const placed = placementOrientation(Date.now());
    expect(placed).not.toBeNull();
    expect(placed!.heading).toBeCloseTo(100, 0);
  });
});

describe('frame hold (localized / enrolling)', () => {
  it('a held frame ignores the compass entirely — pins cannot slide at rest', async () => {
    const { holdYawOffset } = await import('../hooks/useHeading');
    __testFeeds.orientation({ ...upright(0), webkitCompassHeading: 100 });
    const seeded = arOrientation().heading;

    holdYawOffset(true);
    // 5 seconds of the compass insisting on a 30° different bearing — the
    // exact situation after scanning a QR next to a steel column
    for (let i = 0; i < 300; i++) {
      __testFeeds.orientation({ ...upright(0), webkitCompassHeading: 130 });
      vi.advanceTimersByTime(16);
    }
    expect(arOrientation().heading).toBeCloseTo(seeded, 5);

    // released ⇒ corrections resume (with the warm sample window)
    holdYawOffset(false);
    for (let i = 0; i < 300; i++) {
      __testFeeds.orientation({ ...upright(0), webkitCompassHeading: 130 });
      vi.advanceTimersByTime(16);
    }
    const moved = Math.abs(((arOrientation().heading - seeded + 540) % 360) - 180);
    expect(moved).toBeGreaterThan(1);
  });
});
