// The pose maths. `pitch = beta - 90` was right only for a phone held bolt
// upright and unrolled — every other attitude wrote the marker down somewhere
// the technician was not pointing. These lock the three-axis replacement.
import { describe, expect, it } from 'vitest';
import { lookAngles } from '../hooks/useHeading';

/** alpha, beta, gamma for a phone held upright, camera on the horizon. */
const upright = (alpha: number) => lookAngles(alpha, 90, 0);

describe('lookAngles', () => {
  it('agrees with the old two-axis maths where the old maths was valid', () => {
    // upright, unrolled: heading = 360 - alpha, pitch = 0
    expect(upright(0).azimuth).toBeCloseTo(0, 4);
    expect(upright(0).elevation).toBeCloseTo(0, 4);
    expect(upright(90).azimuth).toBeCloseTo(270, 4);
    expect(upright(270).azimuth).toBeCloseTo(90, 4);
    expect(upright(90).elevation).toBeCloseTo(0, 4);
  });

  it('reads flat-on-a-table as looking straight DOWN, not at the horizon', () => {
    expect(lookAngles(0, 0, 0).elevation).toBeCloseTo(-90, 4);
    expect(lookAngles(0, 180, 0).elevation).toBeCloseTo(90, 4);
  });

  it('tilting up and down moves elevation, and only elevation', () => {
    const up = lookAngles(0, 120, 0);
    const down = lookAngles(0, 60, 0);
    expect(up.elevation).toBeCloseTo(30, 4);
    expect(down.elevation).toBeCloseTo(-30, 4);
    expect(up.azimuth).toBeCloseTo(0, 4);
    expect(down.azimuth).toBeCloseTo(0, 4);
  });

  it('HOLDS THE HORIZON WHEN THE PHONE IS ROLLED — the bug this replaces', () => {
    // Landscape, camera still level at the same bearing: beta 0, gamma ±90.
    // The old formula read beta-90 = -90° and threw the marker at the floor.
    const left = lookAngles(0, 0, 90);
    const right = lookAngles(0, 0, -90);
    expect(left.elevation).toBeCloseTo(0, 4);
    expect(right.elevation).toBeCloseTo(0, 4);
    // rolled the opposite way, the camera looks the opposite way: 180° apart
    expect(Math.abs(((left.azimuth - right.azimuth + 540) % 360) - 180)).toBeCloseTo(180, 4);
  });

  it('tilting the phone up keeps the bearing while the old maths lost it', () => {
    // Aiming at a valve high on a wall: beta 130 is a 40° look-up, and the
    // bearing must not wander while the technician tips the phone back.
    for (const beta of [70, 90, 110, 130]) {
      expect(lookAngles(120, beta, 0).azimuth).toBeCloseTo(240, 4);
    }
    expect(lookAngles(120, 130, 0).elevation).toBeCloseTo(40, 4);
  });

  it('always returns a bearing in [0,360) and an elevation in [-90,90]', () => {
    for (const a of [-270, -10, 0, 45, 359, 400]) {
      for (const b of [-90, 0, 45, 90, 180]) {
        for (const g of [-90, -30, 0, 30, 90]) {
          const { azimuth, elevation } = lookAngles(a, b, g);
          expect(azimuth).toBeGreaterThanOrEqual(0);
          expect(azimuth).toBeLessThan(360);
          expect(elevation).toBeGreaterThanOrEqual(-90);
          expect(elevation).toBeLessThanOrEqual(90);
        }
      }
    }
  });
});
