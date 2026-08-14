/**
 * Search over the built estate — the pure half of the "Find an asset" box.
 *
 * The engine's own setSearch() only dims pins on a floor that is already open,
 * which is why typing at estate level looked like the box was broken. This
 * module answers the question the user is actually asking — "where is it?" —
 * and the screen flies to whatever they pick.
 *
 * Structural input type on purpose: buildEstate is JS with hand-written
 * declarations, and search needs four fields, not the whole EstateData shape.
 */

export interface SearchableEstate {
  buildings: Array<{
    id: string;
    name?: string;
    floors: Array<{
      recordId: number;
      name?: string;
      spaces: Array<{ recordId: number; name?: string }>;
      markers: Array<{
        recordId: number;
        name?: string;
        code?: string;
        qrVal?: string | null;
        spaceName?: string | null;
        markerModuleName?: string;
      }>;
    }>;
  }>;
}

export interface EstateSearchHit {
  kind: 'asset' | 'space' | 'building';
  recordId: number | string;
  buildingId: string;
  floorId?: number;
  label: string;
  sub: string;
}

/** Prefix beats substring; ties keep estate order (stable sort). */
function rank(label: string, q: string): number {
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 0;
  if (l.includes(q)) return 1;
  return -1;
}

/** The best rank across several fields, or -1 when none of them match. */
function bestRank(fields: (string | null | undefined)[], q: string): number {
  let best = -1;
  for (const field of fields) {
    if (!field) continue;
    const r = rank(String(field), q);
    if (r >= 0 && (best < 0 || r < best)) best = r;
  }
  return best;
}

export function searchEstate(
  data: SearchableEstate | null | undefined,
  query: string,
  cap = 8,
): EstateSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!data || q.length < 2) return [];

  const buckets: { hit: EstateSearchHit; r: number; order: number }[] = [];
  let order = 0;

  for (const b of data.buildings) {
    const bName = b.name ?? '';
    const rb = rank(bName, q);
    if (rb >= 0) {
      buckets.push({
        // Buildings sort after assets and spaces: "Find an asset" should not
        // bury AHU-03 under the tower that contains it.
        hit: { kind: 'building', recordId: b.id, buildingId: b.id, label: bName, sub: `${b.floors.length} floors` },
        r: rb + 4,
        order: order++,
      });
    }
    for (const f of b.floors) {
      const fName = f.name ?? '';
      for (const m of f.markers) {
        if (m.markerModuleName !== 'asset') continue; // work orders tint assets; they are not destinations
        // Label what the rest of the UI labels. The navigator panel and the
        // breadcrumb both show `code` (the tag number), so someone reading
        // "TA-AHU-01" off the panel and typing it must get a hit — and the old
        // `name ?? code` never could, because buildEstate falls `name` back to
        // the category, making it always truthy and `code` dead.
        const label = String(m.code || m.name || '');
        const r = rank(label, q);
        // Identity first (what it IS), then the weaker matches (where it is,
        // what its code scans as) so a room name cannot outrank a real asset.
        const secondary =
          r < 0
            ? bestRank([m.name, m.qrVal, String(m.recordId), m.spaceName, fName, bName], q)
            : -1;
        if (r < 0 && secondary < 0) continue;
        buckets.push({
          hit: {
            kind: 'asset',
            recordId: m.recordId,
            buildingId: b.id,
            floorId: f.recordId,
            label,
            sub: `${bName} · ${fName}`,
          },
          // An asset matched only by where it sits ranks BELOW the room itself
          // (+2) — someone typing a room name wants the room first — but still
          // above buildings (+4), and always below an asset matched on its own
          // identity.
          r: r >= 0 ? r : secondary + 2.5,
          order: order++,
        });
      }
      for (const sp of f.spaces) {
        const label = sp.name ?? '';
        const r = rank(label, q);
        if (r < 0) continue;
        buckets.push({
          hit: { kind: 'space', recordId: sp.recordId, buildingId: b.id, floorId: f.recordId, label, sub: `${bName} · ${fName}` },
          r: r + 2,
          order: order++,
        });
      }
    }
  }

  buckets.sort((a, z) => a.r - z.r || a.order - z.order);
  return buckets.slice(0, cap).map((x) => x.hit);
}
