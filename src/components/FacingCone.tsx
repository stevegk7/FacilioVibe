/**
 * "Which way do I turn?" — the visible half.
 *
 * A wedge, not an arrow, and the width is the sensor's own reported error. The
 * research this screen is built on is blunt about why: compass heading runs
 * ±15° with a healthy magnetometer and ±30-40° when it is not, and steel
 * structure, lift motors and plant rooms — the places this app is used — are
 * the worst case. An arrow would claim a precision no phone has indoors, and a
 * technician who turns the wrong way on a confident-looking arrow trusts the
 * app less afterwards than one who was never shown a direction at all.
 *
 * The wedge is drawn pointing UP and rotated, so "up" always means "the way you
 * are facing" — the map does not spin, the target does.
 */
import { coneHalfAngleDeg, turnPhrase } from '../wayfinding/facing';

const RAD = Math.PI / 180;

export default function FacingCone({
  relativeDeg,
  accuracyDeg,
  size = 34,
}: {
  /** -180..180, negative = to your left. */
  relativeDeg: number;
  /** Reported compass error; undefined on platforms that do not publish one. */
  accuracyDeg?: number;
  size?: number;
}) {
  const half = coneHalfAngleDeg(accuracyDeg);
  const r = size / 2;
  const cx = r;
  const cy = r;
  // Wedge from the centre, opening upward (-90° in SVG terms), spanning ±half.
  const reach = r - 2;
  const a1 = (-90 - half) * RAD;
  const a2 = (-90 + half) * RAD;
  const p1 = { x: cx + reach * Math.cos(a1), y: cy + reach * Math.sin(a1) };
  const p2 = { x: cx + reach * Math.cos(a2), y: cy + reach * Math.sin(a2) };
  // A cone wider than a half-circle needs the large-arc flag set, or the wedge
  // renders inside-out.
  const largeArc = half > 90 ? 1 : 0;
  const phrase = turnPhrase(relativeDeg);

  return (
    <span
      className="wf-facing"
      // The whole point is the rotation, so it carries the label rather than the
      // wedge: a screen reader gets the words, not a shape.
      role="img"
      aria-label={`Destination ${phrase}`}
      title={`${phrase} · compass accurate to about ±${Math.round(half)}°`}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        focusable="false"
        style={{ transform: `rotate(${relativeDeg}deg)` }}
      >
        <circle cx={cx} cy={cy} r={r - 1} fill="none" stroke="currentColor" strokeOpacity="0.22" />
        <path
          d={`M ${cx} ${cy} L ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${reach} ${reach} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} Z`}
          fill="currentColor"
          fillOpacity="0.28"
          stroke="currentColor"
          strokeWidth="1"
        />
        <circle cx={cx} cy={cy} r="1.6" fill="currentColor" />
      </svg>
    </span>
  );
}
