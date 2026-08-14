/**
 * Step detection — the honesty half of marker accuracy.
 *
 * A marker is a bearing FROM THE STANDPOINT. Walking is not a filtering
 * problem: one metre sideways points a 3m marker ~9.5° wrong by geometry,
 * and no maths on this hardware can put it back. What the app CAN do is
 * know that you walked — accelerometer magnitude carries a clear per-step
 * pulse — and stop pretending: fade the pins and say why, instead of drawing
 * confident wrong answers (the same doctrine as hiding markers without a
 * pose).
 *
 * Detector: |accelerationIncludingGravity| minus its own slow mean (which is
 * gravity, sign conventions cancelling), peak-over-threshold with a
 * refractory window. Deliberately biased toward MISSING dainty steps rather
 * than counting phone waves — a false "you moved" banner teaches people to
 * ignore it.
 */

const STEP_THRESHOLD_MS2 = 1.8;
const REFRACTORY_MS = 320;
/** Slow EMA that tracks gravity + posture, not steps. */
const BASELINE_ALPHA = 0.02;

let baseline = 9.81;
let steps = 0;
let lastStepAt = 0;
let armed = true;
let listening = false;
const stepSubs = new Set<() => void>();

/** Fires once per detected step — dead reckoning hangs off this. */
export function onStep(cb: () => void): () => void {
  stepSubs.add(cb);
  return () => stepSubs.delete(cb);
}

function onMotion(e: DeviceMotionEvent) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  const mag = Math.hypot(a.x, a.y, a.z);
  baseline += (mag - baseline) * BASELINE_ALPHA;
  const dev = mag - baseline;
  const now = Date.now();
  if (armed && dev > STEP_THRESHOLD_MS2 && now - lastStepAt > REFRACTORY_MS) {
    steps += 1;
    lastStepAt = now;
    armed = false;
    for (const cb of stepSubs) cb();
  } else if (dev < STEP_THRESHOLD_MS2 * 0.4) {
    armed = true; // one count per pulse: re-arm only after it subsides
  }
}

/** Idempotent; motion permission is already requested by enableArOrientation. */
export function installMovement(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('devicemotion', onMotion as EventListener, true);
}

/** Zero the counter — call when presence is (re)established. */
export function resetSteps(): void {
  steps = 0;
}

/** Steps since the last reset. */
export function stepsSince(): number {
  return steps;
}

/** TEST ONLY: run the detector without DOM event plumbing. */
export function __feedMotionForTest(x: number, y: number, z: number): void {
  onMotion({ accelerationIncludingGravity: { x, y, z } } as DeviceMotionEvent);
}

/** TEST ONLY. */
export function __resetMovementForTest(): void {
  baseline = 9.81;
  steps = 0;
  lastStepAt = 0;
  armed = true;
}
