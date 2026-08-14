// Angle helpers shared by the AR engine and wayfinding.
// wrap() formula lifted verbatim from asset-lens src/ar/ArSpace.tsx; caption
// thresholds are the ArGuide word-caption spec (|d|<8° straight ahead,
// |d|>150° behind you, else N° left/right).

/** Fold any angle difference into [-180, 180). */
export function wrap(deg: number): number {
  return ((deg + 540) % 360) - 180;
}

/**
 * One phrase a walking person can act on. `delta` is target − current
 * heading; positive means the target is to the right.
 */
export function bearingToCaption(delta: number): string {
  const d = wrap(delta);
  const a = Math.abs(d);
  if (a < 8) return 'straight ahead';
  if (a > 150) return 'behind you';
  return `${Math.round(a)}° ${d > 0 ? 'right' : 'left'}`;
}

const COMPASS_WORDS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
] as const;

/** 8-way compass word for an absolute bearing (0-360, 0 = north). */
export function compassWord(bearingDeg: number): string {
  const b = ((bearingDeg % 360) + 360) % 360;
  return COMPASS_WORDS[Math.round(b / 45) % 8];
}
