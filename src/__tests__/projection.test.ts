// The perspective projection: overlay pixels-per-degree must MATCH the
// displayed camera feed, or the pin slides across the real scene during pans
// (the old innerWidth/60 guess moved the overlay at ~60% of scene speed).
import { describe, expect, it } from 'vitest';
import {
  captureFov,
  displayedFov,
  projectDirection,
  qrAngularOffset,
} from '../ar/projection';
import { quatFromDeviceOrientation, quatMultiply, type Quat } from '../ar/fusion';

const RAD = Math.PI / 180;
/** Upright portrait pose at bearing h. Roll is about the VIEW axis — with the
 * phone upright, gamma is a yaw (the ZXY singularity), so roll must be a
 * rotation about device z applied after the attitude. */
const poseAt = (h: number, pitch = 0, roll = 0): Quat => {
  const base = quatFromDeviceOrientation((360 - h) % 360, 90 + pitch, 0);
  if (!roll) return base;
  const hr = (roll * RAD) / 2;
  return quatMultiply(base, { w: Math.cos(hr), x: 0, y: 0, z: Math.sin(hr) });
};

describe('displayedFov', () => {
  it('cover-crops a 16:9 portrait stream into a taller phone viewport in TANGENT space', () => {
    // 1080x1920 video in a 390x844 view: height fills, width crops
    const fov = displayedFov(1080, 1920, 390, 844, 68);
    const vDeg = 2 * Math.atan(fov.halfTanY) / RAD;
    const hDeg = 2 * Math.atan(fov.halfTanX) / RAD;
    expect(vDeg).toBeCloseTo(68, 0); // long axis fills → keeps the camera FOV
    // crop factor (390/844)/(1080/1920) ≈ 0.821 of tan(37.9°*aspect)…
    // the point: WAY narrower than the 60° the old code assumed
    expect(hDeg).toBeGreaterThan(30);
    expect(hDeg).toBeLessThan(40);
  });

  it('sensor aspect cancels out when the video height fills the viewport', () => {
    // cover-crop property: displayed hFOV = f(long-axis FOV, VIEWPORT aspect)
    // only — a 4:3 iOS default stream and a 16:9 stream show the same slice
    const fov43 = displayedFov(480, 640, 390, 844, 68);
    const fov169 = displayedFov(1080, 1920, 390, 844, 68);
    expect(fov43.halfTanX).toBeCloseTo(fov169.halfTanX, 6);
    expect(fov43.halfTanY).toBeCloseTo(fov169.halfTanY, 6);
  });

  it('falls back to the default when metadata is absent', () => {
    const fov = displayedFov(0, 0, 390, 844);
    expect(2 * Math.atan(fov.halfTanX) / RAD).toBeCloseTo(60, 5);
  });
});

describe('projectDirection', () => {
  const W = 390;
  const H = 844;
  const fov = displayedFov(1080, 1920, W, H, 68);

  it('what the camera points at sits EXACTLY at screen centre', () => {
    const p = projectDirection(137, -12, poseAt(137, -12), W, H, fov);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.visible).toBe(true);
  });

  it('pans move the overlay at scene speed: half the displayed FOV = the screen edge', () => {
    const halfFovDeg = Math.atan(fov.halfTanX) / RAD;
    const p = projectDirection(halfFovDeg, 0, poseAt(0), W, H, fov);
    expect(p.x).toBeCloseTo(W / 2, 0); // the edge, not 60%-of-the-way there
  });

  it('ROLL: tilting the phone sideways keeps an off-centre pin on its spot', () => {
    // marker 10° up; device rolled 30°. In a roll-blind projection the pin
    // stays glued to the screen's vertical axis and SLIDES off the object;
    // the full-attitude projection rotates it around the view axis instead.
    const straight = projectDirection(0, 10, poseAt(0), W, H, fov);
    const rolled = projectDirection(0, 10, poseAt(0, 0, 30), W, H, fov);
    expect(straight.x).toBeCloseTo(0, 3);
    expect(rolled.x).not.toBeCloseTo(0, 0); // moved sideways ON SCREEN…
    // …because the WORLD direction is unchanged — the screen rotated under it.
    const r = Math.hypot(rolled.x / (W / 2 / fov.halfTanX), rolled.y / (H / 2 / fov.halfTanY));
    const s = Math.abs(straight.y / (H / 2 / fov.halfTanY));
    expect(r).toBeCloseTo(s, 2); // same angular distance from centre
  });

  it('behind-the-camera directions are never given screen coordinates', () => {
    const p = projectDirection(180, 0, poseAt(0), W, H, fov);
    expect(p.visible).toBe(false);
  });
});

describe('qrAngularOffset', () => {
  const W = 640;
  const H = 480;
  const fov = captureFov(W, H, 68);
  const square = (cx: number, cy: number, r: number) => ({
    topLeft: { x: cx - r, y: cy - r },
    topRight: { x: cx + r, y: cy - r },
    bottomLeft: { x: cx - r, y: cy + r },
    bottomRight: { x: cx + r, y: cy + r },
  });

  it('a QR dead-centre has zero offset', () => {
    const o = qrAngularOffset(square(W / 2, H / 2, 40), W, H, fov);
    expect(o.yawDeg).toBeCloseTo(0, 6);
    expect(o.pitchDeg).toBeCloseTo(0, 6);
  });

  it('a QR at the right edge is ~half the horizontal FOV away — atan, not linear', () => {
    const o = qrAngularOffset(square(W, H / 2, 40), W, H, fov);
    const halfH = Math.atan(fov.halfTanX) / RAD;
    expect(o.yawDeg).toBeCloseTo(halfH, 1);
  });

  it('above centre = positive pitch (screen y grows downward)', () => {
    const o = qrAngularOffset(square(W / 2, H / 4, 40), W, H, fov);
    expect(o.pitchDeg).toBeGreaterThan(5);
  });

  it('perspective-skewed corners still resolve via the diagonal intersection', () => {
    const o = qrAngularOffset(
      {
        topLeft: { x: 300, y: 200 },
        topRight: { x: 380, y: 210 },
        bottomLeft: { x: 302, y: 282 },
        bottomRight: { x: 378, y: 288 },
      },
      W,
      H,
      fov,
    );
    expect(Number.isFinite(o.yawDeg)).toBe(true);
    expect(Math.abs(o.yawDeg)).toBeLessThan(10); // near-centre quad → small yaw
  });
});
