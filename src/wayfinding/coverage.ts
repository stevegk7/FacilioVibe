/**
 * How much of the portfolio can actually be routed — the authoring debt, counted.
 *
 * Wayfinding degrades quietly. A site with no coordinates cannot take part in a
 * site-to-site route; a floor with no bound plan routes through a synthesised
 * hub with invented distances; an asset whose space carries no floor is dropped
 * from the graph entirely and cannot be found OR routed to. None of that is
 * visible anywhere: today the first person to learn a site is unroutable is a
 * technician standing in a corridor.
 *
 * So this counts it. Pure and total, so the numbers can be tested without a
 * screen and so nothing here can throw into an admin page.
 */
import type { AutoGraph } from './autoGraph';
import type { EstateData, EstateRaw } from '../estate/types';

export interface SiteCoverage {
  /** Null when the estate only knew this site by name. */
  siteId: number | null;
  name: string;
  /** Coordinates present — the gate on every outdoor leg and site-to-site hop. */
  hasGeo: boolean;
  floors: number;
  /** Floors rendering real measured geometry rather than a schematic. */
  floorsWithPlan: number;
  /** QR standpoints: the only positioning primitive that establishes a floor. */
  standpoints: number;
  /** Landmarks authored against this site's derived edges. */
  landmarks: number;
}

/** An asset the graph cannot reach, and why. */
export interface UnroutableAsset {
  id: number;
  name: string;
  reason: string;
}

const isRetired = (name: unknown) =>
  typeof name === 'string' && /obsolete|safe to delete|\[fv-verify\]/i.test(name);

const idOf = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    const raw = (v as { id?: unknown }).id;
    if (typeof raw === 'number') return raw;
  }
  return undefined;
};

/**
 * One row per site in the built estate.
 *
 * Driven off the BUILT estate rather than the raw rows because that is what the
 * router sees — a site the builder dropped is a site nobody can route to, and a
 * readout that disagreed with the router would be worse than none.
 */
export function siteCoverage(
  estate: EstateData,
  opts: {
    /** floorRecordId -> planId, from the KV bindings and the bundled assignments. */
    boundFloorIds?: Iterable<number>;
    /** siteId (as a string key) -> number of standpoints. */
    standpointsBySite?: Record<string, number>;
    /** siteId (as a string key) -> number of authored landmarks. */
    landmarksBySite?: Record<string, number>;
  } = {},
): SiteCoverage[] {
  const bound = new Set(opts.boundFloorIds ?? []);
  const standpoints = opts.standpointsBySite ?? {};
  const landmarks = opts.landmarksBySite ?? {};

  const geoById = new Map<number, boolean>();
  const nameById = new Map<number, string>();
  for (const s of estate.sites ?? []) {
    geoById.set(s.recordId, typeof s.lat === 'number' && typeof s.lng === 'number');
    nameById.set(s.recordId, s.name);
  }

  /* Keyed the way the graph keys its site nodes: by record id when the building
     carries one, by name otherwise. Getting this wrong is what made site geo
     unreachable for so long, so the readout follows the same rule rather than
     inventing a second one. */
  const rows = new Map<string, SiteCoverage>();
  const rowFor = (siteId: number | undefined, name: string): SiteCoverage => {
    const key = siteId != null ? String(siteId) : name;
    const existing = rows.get(key);
    if (existing) return existing;
    const created: SiteCoverage = {
      siteId: siteId ?? null,
      name: siteId != null ? (nameById.get(siteId) ?? name) : name,
      hasGeo: siteId != null ? (geoById.get(siteId) ?? false) : false,
      floors: 0,
      floorsWithPlan: 0,
      standpoints: standpoints[key] ?? 0,
      landmarks: landmarks[key] ?? 0,
    };
    rows.set(key, created);
    return created;
  };

  for (const b of estate.buildings ?? []) {
    const siteId = typeof b.siteId === 'number' ? b.siteId : undefined;
    const row = rowFor(siteId, b.siteName || (siteId != null ? `Site ${siteId}` : 'Site'));
    for (const f of b.floors ?? []) {
      row.floors += 1;
      // `plan` is populated by the builder for a floor with a bound drawing; the
      // id set is the belt to that braces, since a KV binding can name a floor
      // the builder has not reached yet.
      if (f.plan || bound.has(f.recordId)) row.floorsWithPlan += 1;
    }
  }

  // A site with no buildings is still a destination ("walk over to the depot").
  for (const s of estate.sites ?? []) rowFor(s.recordId, s.name);

  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Assets the graph cannot reach.
 *
 * This is the number that matters most and the one nobody could see. An asset
 * whose space carries no floor is dropped by the estate builder, so it is absent
 * from the graph: the assistant answers "I couldn't find that" for a record that
 * plainly exists, and a work order against it cannot be routed to. Two of the
 * ten assets in the reference org are in exactly that state, and one of them has
 * an open work order listed on the Wayfinder's own first screen.
 */
export function unroutableAssets(raw: EstateRaw, graph: AutoGraph): UnroutableAsset[] {
  const inGraph = new Set(
    graph.nodes.filter((n) => n.kind === 'asset').map((n) => n.recordId),
  );
  const spaceById = new Map<number, Record<string, unknown>>();
  for (const sp of raw.spaces ?? []) {
    const id = idOf((sp as { id?: unknown }).id);
    if (id != null) spaceById.set(id, sp as Record<string, unknown>);
  }

  const out: UnroutableAsset[] = [];
  for (const a of raw.assets ?? []) {
    // A null or non-object row is junk from a partial read, not an unroutable
    // asset — and this function must never be the thing that takes an admin
    // page down.
    if (a == null || typeof a !== 'object') continue;
    const row = a as Record<string, unknown>;
    const id = idOf(row.id);
    const name = typeof row.name === 'string' ? row.name : '';
    if (id == null || isRetired(name)) continue;
    if (inGraph.has(id)) continue;

    const spaceId = idOf(row.space) ?? idOf(row.spaceId);
    const space = spaceId != null ? spaceById.get(spaceId) : undefined;
    const spaceName = space && typeof space.name === 'string' ? space.name : undefined;
    const floorId = space ? (idOf(space.floor) ?? idOf(space.floorId)) : undefined;

    let reason: string;
    if (!space) {
      reason = 'its location record is missing from the estate';
    } else if (floorId == null) {
      // The common one, and the fixable one: give the space a floor in Facilio.
      reason = `“${spaceName ?? 'its space'}” has no floor, so it is not on any plate`;
    } else {
      reason = 'the estate builder dropped it';
    }
    out.push({ id, name: name || `Asset ${id}`, reason });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
