/**
 * The route, drawn flat, on one floor.
 *
 * Deliberately 2D. Research on indoor wayfinding finds 3D maps raise cognitive
 * load through information overload and help only users with low spatial
 * ability; even 3D-first vendors fall back on a phone. The 3D estate keeps the
 * jobs it is good at — portfolio overview, and showing where a thing sits in a
 * building — and the walking instruction gets a plate you can read at a glance.
 *
 * Everything is in the floor-local metre frame, and z maps straight to SVG y
 * with no flip, because +z IS the CAD drawing's down. The viewBox is therefore
 * metres, which means stroke widths are in metres too — 0.12 is a 12cm line.
 */
import { plateBounds, polygonPath, polylinePath, type PlateGeometry } from '../wayfinding/plate';

export default function FloorPlate({
  geometry,
  route,
  label,
  height = 168,
}: {
  geometry: PlateGeometry;
  /** The leg's points, floor-local. Fewer than two and no line is drawn. */
  route: Array<{ x: number; z: number }>;
  /** Floor name, announced rather than drawn — the plate has no room for it. */
  label?: string;
  height?: number;
}) {
  const box = plateBounds(geometry, route);
  if (!box) return null;

  const path = polylinePath(route);
  const start = route[0];
  const end = route[route.length - 1];
  // One stroke scale for the whole plate: a big floor and a small one should
  // read the same, so widths follow the frame rather than being fixed pixels.
  const s = Math.max(box.width, box.height) / 100;

  return (
    <figure
      className="wf-plate"
      aria-label={label ? `Route on ${label}` : 'Route on this floor'}
      role="img"
    >
      <svg
        viewBox={`${box.minX} ${box.minZ} ${box.width} ${box.height}`}
        height={height}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        focusable="false"
      >
        {/* Rooms first, as quiet fills — they are context, not content. */}
        {(geometry.rooms ?? []).map((r, i) => (
          <rect
            key={`r${i}`}
            x={Math.min(r.x0, r.x1)}
            y={Math.min(r.z0, r.z1)}
            width={Math.abs(r.x1 - r.x0)}
            height={Math.abs(r.z1 - r.z0)}
            className="wf-plate-room"
          />
        ))}
        {(geometry.spaces ?? []).map((ring, i) => {
          const d = polygonPath(ring);
          return d ? <path key={`s${i}`} d={d} className="wf-plate-room" /> : null;
        })}
        {(geometry.walls ?? []).map((line, i) => {
          const d = polylinePath(line.map((p) => ({ x: p[0], z: p[1] })));
          return d ? (
            <path key={`w${i}`} d={d} className="wf-plate-wall" strokeWidth={s * 1.1} />
          ) : null;
        })}

        {/* The route sits on top of everything, twice: a soft casing so it stays
            legible over dark wall linework, then the line itself. */}
        {path && (
          <>
            <path d={path} className="wf-plate-route-casing" strokeWidth={s * 5} />
            <path d={path} className="wf-plate-route" strokeWidth={s * 2.6} />
          </>
        )}
        {start && <circle cx={start.x} cy={start.z} r={s * 3} className="wf-plate-start" />}
        {end && route.length > 1 && (
          <circle cx={end.x} cy={end.z} r={s * 3.4} className="wf-plate-end" />
        )}
      </svg>
    </figure>
  );
}
