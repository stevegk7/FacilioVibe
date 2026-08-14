// THE one orientation source for the whole app — a two-lane attitude filter.
//
// FAST LANE (drives every frame): the plain 'deviceorientation' stream as a
// quaternion, UNSMOOTHED. On both platforms this stream is already
// gyro-fused by the OS (iOS: CoreMotion attitude; Android Chrome: the game
// rotation vector) — it is smooth and low-latency by construction. The old
// pipeline low-passed it twice anyway (EMA α=0.25 + a k=0.16 per-frame
// follower ≈ 137ms of lag), which is why markers dragged 14° behind a normal
// 100°/s pan and "swam" back when it stopped. There is no smoothing in the
// fast lane any more, and no deadband (that was the stiction).
//
// SLOW LANE (invisible): the fast lane's yaw origin is arbitrary (iOS) or
// magnetometer-noisy (Android). A single scalar yawOffset maps relative yaw
// to true compass bearing, corrected gently (τ = 2s at rest, 8s while
// moving, slewed ≤1°/s, gated off during fast pans) toward the compass
// source — webkitCompassHeading on iOS, 'deviceorientationabsolute' on
// Android. Compass jitter physically cannot wiggle the image: it only
// nudges an offset that moves at a degree per second, while rotation itself
// comes from the gyro-fused lane.
//
// POSE HISTORY: a ring of timestamped attitudes. The camera frame on screen
// is itself ~60-120ms old, so the projection samples the pose AT THE FRAME'S
// AGE (arQuaternionAt) — overlaying a now-pose on an old frame is its own
// misregistration during pans.
//
//  - iOS 13+: DeviceOrientationEvent AND DeviceMotionEvent .requestPermission()
//    gates (call enableArOrientation() from a USER GESTURE).
//  - devicemotion's gyro is used only to measure rotation SPEED (gating,
//    sweep pace) — never as the pose.
import { useEffect, useState } from 'react';
import {
  lookPose,
  quatFromDeviceOrientation,
  quatMultiply,
  slerp,
  type Quat,
} from '../ar/fusion';

export interface Orientation {
  /** 0-360 compass heading of the camera view axis. */
  heading: number;
  /** -90..90, 0 = camera on the horizon. */
  pitch: number;
  /** false until the first sensor event lands. */
  ok: boolean;
  /** True when the heading is north-referenced; false = arbitrary session origin. */
  absolute: boolean;
}

const RAD = Math.PI / 180;

/**
 * Where the REAR CAMERA is looking, from all three axes (see src/ar/fusion).
 * Kept as the angle-pair convenience over the quaternion pose.
 */
export function lookAngles(
  alphaDeg: number,
  betaDeg: number,
  gammaDeg: number,
): { azimuth: number; elevation: number } {
  const p = lookPose(quatFromDeviceOrientation(alphaDeg, betaDeg, gammaDeg));
  return { azimuth: p.azimuth, elevation: p.elevation };
}

const wrap180 = (d: number) => ((d + 540) % 360) - 180;
const wrap360 = (d: number) => ((d % 360) + 360) % 360;

/** Screen-rotation adjustment: deviceorientation speaks PHYSICAL device axes;
 * the projection wants screen axes. Right-multiply by Z(-screenAngle). */
function screenAdjusted(q: Quat): Quat {
  const angle = (typeof screen !== 'undefined' && screen.orientation?.angle) || 0;
  if (!angle) return q;
  const h = (-angle * RAD) / 2;
  return quatMultiply(q, { w: Math.cos(h), x: 0, y: 0, z: Math.sin(h) });
}

/** Rotation that ADDS `deg` to a pose's azimuth. Azimuth runs clockwise from
 * north while Rz runs counterclockwise, hence the negation — getting this
 * backwards makes every compass correction push the pose AWAY from north. */
function yawQuat(deg: number): Quat {
  const h = (-deg * RAD) / 2;
  return { w: Math.cos(h), x: 0, y: 0, z: Math.sin(h) };
}

// ---- state ----

/** Fast lane: latest relative attitude (screen-adjusted). */
let qRel: Quat | null = null;
let relSeenAt = 0;
/** Slow lane: relative yaw + yawOffset = true bearing. */
let yawOffset = 0;
let compassSeenAt = 0;
let offsetSeeded = false;
/** While held, the compass may not move the frame — see holdYawOffset(). */
let offsetHeld = false;

/** Rotation speed (deg/s): the gyro when it speaks, pose deltas otherwise. */
let speedDegS = 0;
let gyroSeenAt = 0;
let lastRelPose: { az: number; el: number; at: number } | null = null;

const raw: Orientation = { heading: 0, pitch: 0, ok: false, absolute: false };
const smoothed: Orientation = { heading: 0, pitch: 0, ok: false, absolute: false };

/** Pose ring for camera-time alignment (~1s at 60Hz). */
const RING = 64;
const ring: Array<{ q: Quat; at: number }> = [];

/**
 * Placement history: a marker is written once, from a single moment, and
 * lives forever — the median of the last ~600ms throws away outliers.
 */
const HISTORY = 40;
const history: Array<{ heading: number; pitch: number; at: number }> = [];

/** Compass samples for the 1s circular mean (never average raw angles). */
const compass: Array<{ sin: number; cos: number; at: number }> = [];
let lastCorrectionAt = 0;
let bigErrorSince = 0;

// slow-lane tuning (from the world-lock research brief)
const TAU_REST_S = 2;
const TAU_MOVING_S = 8;
const REST_DEG_S = 2;
const CORRECT_MAX_SPEED = 10; // never re-anchor mid-pan — that IS the sliding
const SLEW_DEG_S = 1;
const SNAP_ERR_DEG = 35;
const SNAP_AFTER_MS = 2000;
const COMPASS_MAX_PITCH = 60; // compass headings degrade past vertical

function publish(at = Date.now()) {
  if (!qRel) return;
  const world = quatMultiply(yawQuat(yawOffset), qRel);
  const p = lookPose(world);
  smoothed.heading = p.azimuth;
  smoothed.pitch = Math.max(-90, Math.min(90, p.elevation));
  smoothed.ok = true;
  smoothed.absolute = compassSeenAt > 0 && at - compassSeenAt < 10_000;
  ring.push({ q: qRel, at });
  if (ring.length > RING) ring.shift();
  history.push({ heading: smoothed.heading, pitch: smoothed.pitch, at });
  if (history.length > HISTORY) history.shift();
}

function trackSpeedFromPose(az: number, el: number, at: number) {
  if (lastRelPose && at - gyroSeenAt > 400) {
    const dt = (at - lastRelPose.at) / 1000;
    if (dt > 0.001 && dt < 0.5) {
      const d = Math.hypot(wrap180(az - lastRelPose.az), el - lastRelPose.el);
      speedDegS += (d / dt - speedDegS) * 0.3;
    }
  }
  lastRelPose = { az, el, at };
}

// ---- fast lane ----

function ingestRelative(alpha: number | null, beta: number | null, gamma: number | null) {
  if (alpha == null || beta == null) return;
  const at = Date.now();
  qRel = screenAdjusted(quatFromDeviceOrientation(alpha, beta, gamma ?? 0));
  relSeenAt = at;
  const p = lookPose(qRel);
  raw.heading = p.azimuth;
  raw.pitch = Math.max(-90, Math.min(90, p.elevation));
  raw.ok = true;
  trackSpeedFromPose(p.azimuth, p.elevation, at);
  publish(at);
}

// ---- slow lane ----

function ingestCompass(bearingDeg: number, at = Date.now()) {
  if (!qRel) return;
  const rel = lookPose(qRel);
  if (Math.abs(rel.elevation) > COMPASS_MAX_PITCH) return;
  compassSeenAt = at;

  compass.push({ sin: Math.sin(bearingDeg * RAD), cos: Math.cos(bearingDeg * RAD), at });
  while (compass.length && at - compass[0].at > 1000) compass.shift();
  let s = 0;
  let c = 0;
  for (const m of compass) {
    s += m.sin;
    c += m.cos;
  }
  const mean = wrap360(Math.atan2(s, c) / RAD);

  const e = wrap180(mean - (rel.azimuth + yawOffset));

  // HELD: once a survey Δ has been measured (or an enrolment is in flight),
  // the frame those bearings were written in must not move underneath them.
  // The compass's only job was to name north; registration to the PLACE now
  // comes from the QR/visual Δ, and every compass correction after that
  // point is pure marker slide (up to the full 1°/s slew, plus 35°+ snaps).
  // Samples keep accumulating so release resumes with a warm mean.
  if (offsetHeld && offsetSeeded) return;

  if (!offsetSeeded) {
    yawOffset = wrap360(yawOffset + e);
    offsetSeeded = true;
    lastCorrectionAt = at;
    publish(at);
    return;
  }

  // escape hatch: a sustained huge disagreement snaps once instead of
  // grinding through the slew clamp for half a minute
  if (Math.abs(e) > SNAP_ERR_DEG) {
    if (!bigErrorSince) bigErrorSince = at;
    if (at - bigErrorSince > SNAP_AFTER_MS) {
      yawOffset = wrap360(yawOffset + e);
      bigErrorSince = 0;
      lastCorrectionAt = at;
      publish(at);
      return;
    }
  } else {
    bigErrorSince = 0;
  }

  if (speedDegS > CORRECT_MAX_SPEED) return; // re-anchoring mid-pan IS visible slide
  const dt = Math.min(1, Math.max(0.001, (at - (lastCorrectionAt || at)) / 1000));
  lastCorrectionAt = at;
  const tau = speedDegS < REST_DEG_S ? TAU_REST_S : TAU_MOVING_S;
  const step = Math.max(-SLEW_DEG_S * dt, Math.min(SLEW_DEG_S * dt, e * Math.min(1, dt / tau)));
  yawOffset = wrap360(yawOffset + step);
}

// ---- event wiring ----

let listening = false;

function onDeviceOrientation(e: DeviceOrientationEvent) {
  const webkit = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
  const accuracy = (e as unknown as { webkitCompassAccuracy?: number }).webkitCompassAccuracy;
  // iOS: this event carries BOTH lanes — CoreMotion attitude in the angles
  // (arbitrary yaw origin) and the north reference in webkitCompassHeading.
  ingestRelative(e.alpha, e.beta, e.gamma);
  if (
    typeof webkit === 'number' &&
    !Number.isNaN(webkit) &&
    (typeof accuracy !== 'number' || (accuracy >= 0 && accuracy <= 50))
  ) {
    // compass heading is where the device TOP points; the camera looks out
    // the back. Derive the camera bearing by re-basing the relative pose's
    // yaw origin — the relative attitude carries the geometry, the compass
    // only names north. heading_cam = rel.azimuth + (northRef - rel_topYaw)
    // collapses to feeding the equivalent alpha through the same maths:
    const qNorth = screenAdjusted(quatFromDeviceOrientation((360 - webkit) % 360, e.beta ?? 0, e.gamma ?? 0));
    ingestCompass(lookPose(qNorth).azimuth);
  }
}

function onDeviceOrientationAbsolute(e: DeviceOrientationEvent) {
  if (e.alpha == null || e.beta == null) return;
  // Android: magnetometer-referenced attitude (noisy, ~10Hz worth of real
  // data). Only its BEARING is consumed, as the slow lane's compass source.
  const q = screenAdjusted(quatFromDeviceOrientation(e.alpha, e.beta, e.gamma ?? 0));
  ingestCompass(lookPose(q).azimuth);
  // Some devices fire ONLY the absolute event — then it is also the fast lane.
  if (Date.now() - relSeenAt > 1000) ingestRelative(e.alpha, e.beta, e.gamma);
}

function onDeviceMotion(e: DeviceMotionEvent) {
  const rr = e.rotationRate;
  if (!rr || rr.alpha == null || rr.beta == null || rr.gamma == null) return;
  gyroSeenAt = Date.now();
  const mag = Math.hypot(rr.alpha, rr.beta, rr.gamma); // deg/s everywhere since 2018
  speedDegS += (mag - speedDegS) * 0.3;
}

export type OrientationStatus = 'idle' | 'waiting' | 'live' | 'denied' | 'unsupported';
let permission: 'unknown' | 'granted' | 'denied' = 'unknown';

function startListening() {
  if (listening) return;
  listening = true;
  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', onDeviceOrientationAbsolute as EventListener, true);
  }
  window.addEventListener('deviceorientation', onDeviceOrientation as EventListener, true);
  window.addEventListener('devicemotion', onDeviceMotion as EventListener, true);
}

/** What the AR layer should SAY about the sensor, rather than guessing. */
export function orientationStatus(): OrientationStatus {
  if (smoothed.ok) return 'live';
  if (permission === 'denied') return 'denied';
  if (!listening) return 'idle';
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window
    ? 'waiting'
    : 'unsupported';
}

/**
 * iOS needs user-gesture permissions — orientation AND motion are separate
 * gates, requested sequentially inside the same tap. Safe to call repeatedly,
 * and it must be: a technician who dismissed the prompt once has to be able
 * to ask again from the banner rather than being locked out for the session.
 */
export async function enableArOrientation(): Promise<boolean> {
  const g = globalThis as {
    DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
    DeviceMotionEvent?: { requestPermission?: () => Promise<string> };
  };
  try {
    if (g.DeviceOrientationEvent && typeof g.DeviceOrientationEvent.requestPermission === 'function') {
      const res = await g.DeviceOrientationEvent.requestPermission();
      if (res !== 'granted') {
        permission = 'denied';
        return false;
      }
      permission = 'granted';
    }
    try {
      if (g.DeviceMotionEvent && typeof g.DeviceMotionEvent.requestPermission === 'function') {
        await g.DeviceMotionEvent.requestPermission();
      }
    } catch {
      /* the gyro is a speed gauge here, not the pose — denial is survivable */
    }
    startListening();
    return true;
  } catch {
    return false;
  }
}

/** Circular median — bearings wrap, so a plain median is wrong near north. */
function circularMedian(values: number[]): number {
  const base = values[0];
  const unwrapped = values.map((v) => base + wrap180(v - base));
  const sorted = [...unwrapped].sort((a, b) => a - b);
  return wrap360(sorted[Math.floor(sorted.length / 2)]);
}

/**
 * The reading to WRITE INTO a survey: the median of the last ~600ms.
 * Returns null when the sensors are not answering — placement must never
 * invent a bearing.
 */
export function placementOrientation(
  now = Date.now(),
): { heading: number; pitch: number; samples: number } | null {
  if (!smoothed.ok) return null;
  const recent = history.filter((h) => now - h.at <= 600);
  if (recent.length === 0) {
    return { heading: smoothed.heading, pitch: smoothed.pitch, samples: 1 };
  }
  const pitches = recent.map((h) => h.pitch).sort((a, b) => a - b);
  return {
    heading: circularMedian(recent.map((h) => h.heading)),
    pitch: pitches[Math.floor(pitches.length / 2)],
    samples: recent.length,
  };
}

/** Latest fused pose as angles. Live object — read, never mutate. */
export function arOrientation(): Orientation {
  return smoothed;
}

/** Latest world attitude (yawOffset applied), for the projection. */
export function arQuaternion(): Quat | null {
  return qRel ? quatMultiply(yawQuat(yawOffset), qRel) : null;
}

/**
 * World attitude AS OF `atMs` — the projection samples the pose at the
 * camera frame's age, because pinning a now-pose onto an old frame smears
 * markers across the scene during pans. Interpolates the ring; returns the
 * newest pose when the ring cannot reach that far back.
 */
export function arQuaternionAt(atMs: number): Quat | null {
  if (!qRel) return null;
  const yaw = yawQuat(yawOffset);
  if (ring.length < 2 || atMs >= ring[ring.length - 1].at) {
    return quatMultiply(yaw, qRel);
  }
  if (atMs <= ring[0].at) return quatMultiply(yaw, ring[0].q);
  for (let i = ring.length - 2; i >= 0; i--) {
    const a = ring[i];
    const b = ring[i + 1];
    if (atMs >= a.at) {
      const t = (atMs - a.at) / Math.max(1, b.at - a.at);
      return quatMultiply(yaw, slerp(a.q, b.q, t));
    }
  }
  return quatMultiply(yaw, qRel);
}

/** Rotation speed (deg/s, low-passed) — sweep pace gate, correction gating. */
export function poseSpeedDegS(): number {
  return smoothed.ok ? speedDegS : 0;
}

/**
 * Freeze the world frame. Call with true the moment bearings start being
 * WRITTEN against the current frame (survey enrolment) or a Δ has been
 * measured in it (presence at a standpoint); false when that ends. While
 * held, the compass cannot slide markers — the gyro-fused relative lane is
 * drift-free on the minutes scale, and the QR re-scan re-roots exactly.
 */
export function holdYawOffset(hold: boolean): void {
  offsetHeld = hold;
}

/** Unsmoothed latest fast-lane reading, for diagnostics. */
export function rawOrientation(): Orientation {
  return raw;
}

/**
 * React view of the fused pose, sampled at `sampleMs` — for chrome text
 * (compass readouts, sweep progress). The 60fps hot path must NOT use this;
 * it reads arOrientation()/arQuaternionAt() inside the rAF loop instead.
 */
export function useHeading(sampleMs = 250): Orientation {
  const [pose, setPose] = useState<Orientation>(() => ({ ...smoothed }));
  useEffect(() => {
    const t = setInterval(() => {
      setPose((prev) =>
        prev.heading === smoothed.heading && prev.pitch === smoothed.pitch && prev.ok === smoothed.ok
          ? prev
          : { ...smoothed },
      );
    }, sampleMs);
    return () => clearInterval(t);
  }, [sampleMs]);
  return pose;
}

/** TEST ONLY: force the pose (null heading = back to "no sensor yet"). */
export function setOrientationForTest(heading: number | null, pitch = 0): void {
  if (heading == null) {
    raw.ok = false;
    smoothed.ok = false;
    qRel = null;
    yawOffset = 0;
    offsetSeeded = false;
    offsetHeld = false;
    compassSeenAt = 0;
    lastRelPose = null;
    speedDegS = 0;
    ring.length = 0;
    history.length = 0;
    compass.length = 0;
    return;
  }
  const h = wrap360(heading);
  // an upright, unrolled device looking at bearing h
  qRel = quatFromDeviceOrientation((360 - h) % 360, 90 + pitch, 0);
  yawOffset = 0;
  raw.heading = h;
  raw.pitch = pitch;
  raw.ok = true;
  raw.absolute = true;
  smoothed.heading = h;
  smoothed.pitch = pitch;
  smoothed.ok = true;
  smoothed.absolute = true;
}

/** TEST ONLY: run the real event handlers without DOM event constructors. */
export const __testFeeds = {
  orientation: (e: Partial<DeviceOrientationEvent> & { webkitCompassHeading?: number }) =>
    onDeviceOrientation(e as DeviceOrientationEvent),
  orientationAbsolute: (e: Partial<DeviceOrientationEvent>) =>
    onDeviceOrientationAbsolute(e as DeviceOrientationEvent),
  motion: (e: { rotationRate: { alpha: number; beta: number; gamma: number } }) =>
    onDeviceMotion(e as unknown as DeviceMotionEvent),
};
