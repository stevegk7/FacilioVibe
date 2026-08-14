import { useEffect, useRef } from 'react';
import type { EstateEngineApi } from './types';

/**
 * Which way you are facing while orbiting the model.
 *
 * Two deliberate choices.
 *
 * It writes the rotation straight to the DOM through a ref inside a
 * requestAnimationFrame loop, and never calls setState. The orbit angle changes
 * every frame of every drag; routing that through React would re-render the
 * whole estate screen sixty times a second to move one needle.
 *
 * And it reads MODEL north, not magnetic north. The estate is assembled from
 * CAD plans and a containment hierarchy, neither of which carries a geographic
 * bearing, so a needle claiming true north would be inventing one. This answers
 * "which way am I facing relative to how this building is drawn" — the question
 * someone rotating a model actually has — and the tooltip says so.
 */
export default function Compass({
  engineRef,
  style,
}: {
  engineRef: { current: EstateEngineApi | null };
  /** Vertical offset only — the screen owns where the control cluster sits. */
  style?: { bottom: number };
}) {
  const dialRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let last = Number.NaN;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const engine = engineRef.current;
      // getHeading arrived with the compass; an older engine parked on the
      // shared canvas may not have it yet.
      if (!engine || typeof engine.getHeading !== 'function') return;

      const heading = engine.getHeading();
      if (!Number.isFinite(heading) || heading === last) return; // idle: no DOM write
      last = heading;
      const dial = dialRef.current;
      if (dial) dial.style.transform = `rotate(${(heading * 180) / Math.PI}deg)`;
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engineRef]);

  return (
    <div
      className="est-compass"
      style={style}
      title="North as this building is drawn — the model's own axis, not a magnetic bearing."
      aria-hidden="true"
    >
      <div className="est-compass-dial" ref={dialRef}>
        <span className="est-compass-n">N</span>
        <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
          {/* Needle: the filled half points north, so the direction reads at a
              glance without having to find the letter. */}
          <path d="M20 7 L24.5 20 L20 17.5 L15.5 20 Z" fill="var(--accent, #6b4ef5)" />
          <path d="M20 33 L15.5 20 L20 22.5 L24.5 20 Z" fill="var(--ink-300, #c3c9d4)" />
        </svg>
      </div>
    </div>
  );
}
