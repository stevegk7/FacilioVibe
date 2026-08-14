/**
 * "Which way do I turn?" — the pure half.
 *
 * A route step can carry a compass bearing, and the device can report which way
 * it is pointing. The difference between the two is the only genuinely useful
 * thing a phone can tell a technician standing at a lift lobby, because the
 * failure at a standpoint is almost always ROTATIONAL: they know where they are
 * and not which way to face.
 *
 * Everything here is deliberately honest about how little a browser knows:
 *
 *  - A heading that is not north-referenced (`absolute: false`) is a session
 *    origin, not a bearing. It is unusable for this and is refused outright
 *    rather than drawn slightly wrong.
 *  - The indicator is a CONE, never an arrow. Situm measures compass heading at
 *    ±15° with a healthy magnetometer, degrading to ±30-40° when uncalibrated —
 *    and steel structure, lift motors and plant rooms, which is exactly where
 *    this app is used, are the worst case. A narrow arrow claims a precision no
 *    phone has indoors.
 *  - iOS reports its own error via webkitCompassAccuracy, so where a real number
 *    exists the cone is sized from it. Android reports nothing, so the cone
 *    falls back to the pessimistic end of the range instead of the flattering
 *    one.
 */

/** Signed difference to a target bearing: -180..180, negative = to your left. */
export function relativeBearing(targetDeg: number, headingDeg: number): number {
  return ((targetDeg - headingDeg + 540) % 360) - 180;
}

/**
 * Half-width of the confidence cone, in degrees.
 *
 * Clamped at both ends: never narrower than 15° (nobody's magnetometer is
 * better than that in a plant room, whatever it claims), and never wider than
 * 60°, past which the cone stops being a direction and the caller should say
 * so instead of drawing most of the horizon.
 */
export const CONE_MIN_DEG = 15;
export const CONE_MAX_DEG = 60;
/** What we assume when the platform reports nothing — the degraded end. */
export const CONE_UNKNOWN_DEG = 35;

export function coneHalfAngleDeg(accuracyDeg?: number): number {
  const reported = typeof accuracyDeg === 'number' && accuracyDeg >= 0 ? accuracyDeg : CONE_UNKNOWN_DEG;
  return Math.min(CONE_MAX_DEG, Math.max(CONE_MIN_DEG, reported));
}

/**
 * Whether a facing indicator may be drawn at all.
 *
 * The bar is deliberately high. Half a direction is worse than none: a
 * technician who turns the wrong way on a confident-looking arrow trusts the
 * app less afterwards than one who was never shown an arrow.
 */
export function canShowFacing(
  bearing: number | undefined,
  orientation: { ok: boolean; absolute: boolean; accuracyDeg?: number },
): boolean {
  if (typeof bearing !== 'number' || !Number.isFinite(bearing)) return false;
  if (!orientation.ok || !orientation.absolute) return false;
  // A reported error past the cone ceiling is the sensor telling us it does not
  // know. Believe it.
  return coneHalfAngleDeg(orientation.accuracyDeg) < CONE_MAX_DEG;
}

export type TurnPhrase =
  | 'straight ahead'
  | 'slightly left'
  | 'slightly right'
  | 'to your left'
  | 'to your right'
  | 'behind you';

/**
 * Words for a relative bearing, at a resolution the sensor can actually support.
 *
 * The bands are wide on purpose — with a cone of ±15-40° there is no honest way
 * to say "at 2 o'clock", so it says the thing that stays true across the whole
 * cone. "Behind you" is a real answer and the one people most need at a lift
 * lobby.
 */
export function turnPhrase(relativeDeg: number): TurnPhrase {
  const d = ((relativeDeg + 540) % 360) - 180;
  const a = Math.abs(d);
  if (a <= 20) return 'straight ahead';
  if (a >= 135) return 'behind you';
  if (a <= 60) return d < 0 ? 'slightly left' : 'slightly right';
  return d < 0 ? 'to your left' : 'to your right';
}
