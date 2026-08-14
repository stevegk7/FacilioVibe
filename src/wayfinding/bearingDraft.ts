/**
 * Deciding a new marker's bearing.
 *
 * Extracted because the bug it fixes was invisible from the UI: when the
 * compass was silent, the screen wrote heading 0 for EVERY marker, so notes
 * stacked on a single point in the AR view and were saved that way. The rule
 * is now explicit and unit-testable: an unknown bearing is never turned into
 * a real-looking number behind the user's back.
 */
export interface BearingDraft {
  /** Degrees relative to sweep frame 0. */
  rel: number;
  /** False when the compass could not supply it — the form must then ask. */
  bearingKnown: boolean;
}

/** Spread for hand-placed markers so consecutive ones cannot land together. */
export const MANUAL_SPREAD_DEG = 40;

export function draftBearing(opts: {
  /** Absolute device heading, or null when the compass is not answering. */
  heading: number | null;
  /** Heading of sweep frame 0 — the survey's reference direction. */
  sweepBase: number;
  /** How many markers already exist, used to spread manual suggestions. */
  markerCount: number;
}): BearingDraft {
  const { heading, sweepBase, markerCount } = opts;
  if (heading === null) {
    return {
      rel: (markerCount * MANUAL_SPREAD_DEG) % 360,
      bearingKnown: false,
    };
  }
  return { rel: ((heading - sweepBase) % 360 + 360) % 360, bearingKnown: true };
}
