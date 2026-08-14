import { useEffect, useState } from 'react';
import { currentStopIndex, onActiveRoundChange } from './roundsStore';
import type { ActiveRound } from './roundsStore';
import './rounds.css';

/**
 * The "you are mid-round" reminder. Mounted globally by the shell so a
 * technician who wanders off to a work order still knows a walk is open and
 * which stop is next. Renders nothing when no round is active.
 */
export default function ActiveRoundChip() {
  const [active, setActive] = useState<ActiveRound | null>(null);

  useEffect(() => onActiveRoundChange(setActive), []);

  if (!active) return null;
  const done = active.stops.filter((s) => s.via).length;
  const next = currentStopIndex(active);

  return (
    <div className="round-chip" role="status" aria-label="Active round">
      <span className="round-chip-dot" aria-hidden="true" />
      <strong>{active.roundName}</strong>
      <span className="round-chip-count">
        {done}/{active.stops.length}
      </span>
      {next >= 0 && <span className="round-chip-next">stop {next + 1} next</span>}
    </div>
  );
}
