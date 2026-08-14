/**
 * Quaternion attitude for the AR pose — the maths that lets a pin STAY PUT.
 *
 * Angles alone cannot do this job. A heading+pitch pair ignores roll, wraps
 * awkwardly at north, and worst of all invites per-angle smoothing — which is
 * exactly the double-EMA lag that made markers drag behind the camera and
 * "swim" back when the pan stopped. Attitude is one rotation; it is filtered
 * here as one rotation.
 *
 * Frames:
 *  - World: x = East, y = North, z = Up (the DeviceOrientation spec's frame).
 *  - Device: x = right edge, y = top edge, z = out of the screen.
 *    The rear camera looks along device -z.
 *  - Quaternions are DEVICE→WORLD, {w,x,y,z}, unit length.
 */

export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const QUAT_IDENTITY: Quat = { w: 1, x: 0, y: 0, z: 0 };

export function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q.w, q.x, q.y, q.z) || 1;
  return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

/**
 * The spec's own composition: intrinsic Z(alpha) X(beta) Y(gamma), device to
 * world. Must agree with lookAngles' rotation matrix — the fusion corrects
 * toward this, so a disagreement would be a permanent tug-of-war.
 */
export function quatFromDeviceOrientation(alphaDeg: number, betaDeg: number, gammaDeg: number): Quat {
  const ha = (alphaDeg * RAD) / 2;
  const hb = (betaDeg * RAD) / 2;
  const hg = (gammaDeg * RAD) / 2;
  const qz: Quat = { w: Math.cos(ha), x: 0, y: 0, z: Math.sin(ha) };
  const qx: Quat = { w: Math.cos(hb), x: Math.sin(hb), y: 0, z: 0 };
  const qy: Quat = { w: Math.cos(hg), x: 0, y: Math.sin(hg), z: 0 };
  return quatMultiply(quatMultiply(qz, qx), qy);
}

/** Rotate a vector by q (device→world). */
export function rotate(q: Quat, v: [number, number, number]): [number, number, number] {
  // v' = q v q*  (expanded, no allocation of intermediate quats)
  const { w, x, y, z } = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/** Rotate by the INVERSE of q (world→device). */
export function rotateInv(q: Quat, v: [number, number, number]): [number, number, number] {
  return rotate({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, v);
}

export interface LookPose {
  /** Compass bearing of the camera's view axis, 0..360. */
  azimuth: number;
  /** -90..90, + = looking up. */
  elevation: number;
  /** Rotation of the device about the view axis, deg. 0 = upright portrait. */
  roll: number;
}

/**
 * Where the rear camera looks, plus how the device is rolled about that axis.
 * Roll is what lets the projection keep a pin glued while the phone tilts
 * sideways — the third axis the old heading/pitch pose threw away.
 */
export function lookPose(q: Quat): LookPose {
  const view = rotate(q, [0, 0, -1]); // camera view axis, world frame
  const azimuth = ((Math.atan2(view[0], view[1]) * DEG) % 360 + 360) % 360;
  const elevation = Math.asin(Math.max(-1, Math.min(1, view[2]))) * DEG;

  // Device "screen up" (+y) measured against the world-up direction projected
  // perpendicular to the view axis. atan2 of its components along screen-right
  // vs screen-up gives the roll.
  const upScreen = rotate(q, [0, 1, 0]);
  const rightScreen = rotate(q, [1, 0, 0]);
  // world up, made perpendicular to view
  const wu: [number, number, number] = [0 - view[0] * view[2], 0 - view[1] * view[2], 1 - view[2] * view[2]];
  const n = Math.hypot(...wu);
  if (n < 1e-6) {
    // looking straight up/down — roll is degenerate; report 0 rather than noise
    return { azimuth, elevation, roll: 0 };
  }
  const u: [number, number, number] = [wu[0] / n, wu[1] / n, wu[2] / n];
  const cosR = u[0] * upScreen[0] + u[1] * upScreen[1] + u[2] * upScreen[2];
  const sinR = u[0] * rightScreen[0] + u[1] * rightScreen[1] + u[2] * rightScreen[2];
  return { azimuth, elevation, roll: Math.atan2(sinR, cosR) * DEG };
}

/** World unit vector for a stored marker direction (bearing + pitch). */
export function dirVector(bearingDeg: number, pitchDeg: number): [number, number, number] {
  const b = bearingDeg * RAD;
  const p = pitchDeg * RAD;
  return [Math.sin(b) * Math.cos(p), Math.cos(b) * Math.cos(p), Math.sin(p)];
}

/**
 * Integrate body-frame angular rates into the attitude:
 * q ← q ⊗ exp(½ ω dt). Rates in deg/s about the DEVICE axes — exactly what
 * DeviceMotionEvent.rotationRate reports (beta:x, gamma:y, alpha:z).
 */
export function integrateGyro(
  q: Quat,
  rates: { alpha: number; beta: number; gamma: number },
  dtSec: number,
): Quat {
  const wx = rates.beta * RAD;
  const wy = rates.gamma * RAD;
  const wz = rates.alpha * RAD;
  const mag = Math.hypot(wx, wy, wz);
  if (mag * dtSec < 1e-8) return q;
  const half = (mag * dtSec) / 2;
  const s = Math.sin(half) / mag;
  const dq: Quat = { w: Math.cos(half), x: wx * s, y: wy * s, z: wz * s };
  return quatNormalize(quatMultiply(q, dq));
}

/** Shortest-path slerp — the complementary filter's correction step. */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  let cos = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
  let bw = b.w, bx = b.x, by = b.y, bz = b.z;
  if (cos < 0) {
    cos = -cos;
    bw = -bw; bx = -bx; by = -by; bz = -bz;
  }
  if (cos > 0.9995) {
    // nearly parallel — lerp, then normalize (slerp is numerically unstable here)
    return quatNormalize({
      w: a.w + t * (bw - a.w),
      x: a.x + t * (bx - a.x),
      y: a.y + t * (by - a.y),
      z: a.z + t * (bz - a.z),
    });
  }
  const theta = Math.acos(Math.min(1, cos));
  const sin = Math.sin(theta);
  const fa = Math.sin((1 - t) * theta) / sin;
  const fb = Math.sin(t * theta) / sin;
  return quatNormalize({
    w: fa * a.w + fb * bw,
    x: fa * a.x + fb * bx,
    y: fa * a.y + fb * by,
    z: fa * a.z + fb * bz,
  });
}

/** Angle between two attitudes, deg — drives the adaptive correction gain. */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const cos = Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z);
  return 2 * Math.acos(Math.min(1, cos)) * DEG;
}
