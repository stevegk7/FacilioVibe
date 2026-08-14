/**
 * Pedestrian dead reckoning — WHERE the technician stands, relative to the
 * standpoint they localized at.
 *
 * Every detected step advances the position estimate one stride along the
 * camera heading at that moment. The assumption — a person walks the way
 * they are facing — is how every phone PDR works, and it is right for the
 * field pattern this app serves (walk to the thing, then turn to look).
 * Error compounds at roughly 10-20% of distance walked, which is why the
 * estimate is trusted for metres, not corridors: within TRUST_RADIUS_M the
 * markers are REPROJECTED from the estimated position (see
 * parallaxCorrected); beyond it the app goes back to honest fading.
 *
 * The origin re-zeros on every localization proof (QR scan, visual match) —
 * each proof means "you are AT the standpoint again".
 */
import { arOrientation } from '../hooks/useHeading';
import { installMovement, onStep } from './movement';

/** Mean adult indoor stride. Being 10% wrong scales the correction 10%,
 * which still beats the uncorrected bearing by miles at room scale. */
export const STRIDE_M = 0.72;
/** Beyond this, compounded PDR error rivals the correction itself. */
export const TRUST_RADIUS_M = 6;

export interface PdrOffset {
  /** metres East of the standpoint */
  x: number;
  /** metres North of the standpoint */
  y: number;
  dist: number;
  steps: number;
}

let x = 0;
let y = 0;
let steps = 0;
let unsub: (() => void) | null = null;

const RAD = Math.PI / 180;

/** Idempotent — safe to call whenever the AR stage is live. */
export function installPdr(): void {
  installMovement();
  if (unsub) return;
  unsub = onStep(() => {
    const pose = arOrientation();
    if (!pose.ok) return; // a step with no heading is unusable — skip it
    x += STRIDE_M * Math.sin(pose.heading * RAD);
    y += STRIDE_M * Math.cos(pose.heading * RAD);
    steps += 1;
  });
}

/** Zero the estimate — call on every localization proof. */
export function resetPdr(): void {
  x = 0;
  y = 0;
  steps = 0;
}

export function pdrOffset(): PdrOffset {
  return { x, y, dist: Math.hypot(x, y), steps };
}

/** TEST ONLY: inject a step at a given heading without sensors. */
export function __stepForTest(headingDeg: number): void {
  x += STRIDE_M * Math.sin(headingDeg * RAD);
  y += STRIDE_M * Math.cos(headingDeg * RAD);
  steps += 1;
}
