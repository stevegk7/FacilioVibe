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
        const label = String(m.name ?? m.code ?? '');
        const r = rank(label, q);
        if (r < 0) continue;
        buckets.push({
          hit: { kind: 'asset', recordId: m.recordId, buildingId: b.id, floorId: f.recordId, label, sub: `${bName} · ${fName}` },
          r,
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
