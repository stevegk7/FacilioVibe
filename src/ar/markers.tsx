// Marker/card family — Vision AR System design, foundation 03.
// One anatomy: a head carrying the label, a 4px status edge, a stem pointing
// at the anchor. STATUS COLOUR IS THE ONLY COLOUR THAT VARIES. These are the
// components the Phase 5 rAF loop will position; they own no layout of their
// own beyond absolute placement via `style`.
import type { CSSProperties } from 'react';

export type MarkerStatus = 'red' | 'amber' | 'green';

const STATUS_CLASS: Record<MarkerStatus, string> = {
  red: 'st-red',
  amber: 'st-amber',
  green: 'st-green',
};

interface AssetTagProps {
  name: string;
  sub?: string;
  status: MarkerStatus;
  openCount?: number;
  plannedCount?: number;
  selected?: boolean;
  decaying?: boolean;
  style?: CSSProperties;
  onClick?(): void;
}

export function AssetTag({
  name,
  sub,
  status,
  openCount = 0,
  plannedCount = 0,
  selected,
  decaying,
  style,
  onClick,
}: AssetTagProps) {
  const cls = [
    'ar-asset-tag',
    selected ? 'selected' : '',
    decaying ? 'decaying' : '',
  ]
    .filter(Boolean)
    .join(' ');
  // The status dot doubles as the ANCHOR: it sits exactly on the projected
  // point (the pixel that was aimed at placement); the plate hangs below.
  return (
    <button className={cls} style={style} onClick={onClick}>
      <span className={`edge ${STATUS_CLASS[status]}`} />
      <span className="plate">
        <span className="body">
          <span className="name">{name}</span>
          {sub && <span className="sub">{sub}</span>}
          {(openCount > 0 || plannedCount > 0) && (
            <span className="counts">
              {openCount > 0 && <span className="ar-count open">{openCount} open</span>}
              {plannedCount > 0 && <span className="ar-count planned">{plannedCount} planned</span>}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

export function NoteTag({
  text,
  style,
  onClick,
}: {
  text: string;
  style?: CSSProperties;
  onClick?(): void;
}) {
  return (
    <button className="ar-note-tag" style={style} onClick={onClick}>
      <span className="anchor st-amber" aria-hidden="true" />
      <span className="plate">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFD405" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 16px' }} aria-hidden="true">
          <path d="M5 4h9l5 5v11H5z" />
          <path d="M14 4v5h5" />
        </svg>
        <span className="txt">{text}</span>
      </span>
    </button>
  );
}

export function WoPin({
  count,
  status,
  style,
  onClick,
}: {
  count: number;
  status: MarkerStatus;
  style?: CSSProperties;
  onClick?(): void;
}) {
  return (
    <button className="ar-wo-pin" style={style} onClick={onClick} aria-label={`${count} work orders`}>
      <span className={`head ${STATUS_CLASS[status]}`}>{count}</span>
      <span className="stem" />
      <span className="anchor" />
    </button>
  );
}

export function StandpointMarker({
  label,
  relocalizing,
  style,
}: {
  label: string;
  relocalizing?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className={relocalizing ? 'ar-standpoint-marker relocalizing' : 'ar-standpoint-marker'}
      style={style}
    >
      <span className="head">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" />
        </svg>
      </span>
      <span className="lbl">{label}</span>
    </div>
  );
}

export function MinimizedDot({
  label,
  status,
  style,
  onClick,
}: {
  label: string;
  status: MarkerStatus;
  style?: CSSProperties;
  onClick?(): void;
}) {
  return (
    <button className="ar-min-dot" style={style} onClick={onClick} aria-label={`Restore ${label}`}>
      <span className={`dot ${STATUS_CLASS[status]}`} />
      <span className="lbl">{label}</span>
    </button>
  );
}
