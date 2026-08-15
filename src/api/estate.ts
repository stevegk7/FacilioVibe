/**
 * Transport for the 3D estate — the half of Estate Navigator's facilioEstate.js
 * that talks to Facilio, rebuilt on the shared helpers.
 *
 * Estate Navigator had its own `rowsOf`, which returned `[]` for ANY response it
 * did not recognise — including the CMMS's in-band `{success:false}` failure,
 * reported at HTTP 200. A failed list-assets therefore rendered as an estate
 * with no equipment, silently. `execute()` in facilioHelpers throws on that
 * shape, so routing the estate through it is a correctness upgrade, not just
 * tidiness.
 *
 * Lives in src/api because it is the only place allowed to reach the SDK
 * (enforced by src/__tests__/provider-seam.test.ts).
 */
import { fetchAllPages } from './facilioHelpers';
import { visibleRows } from './recordPolicy';
import { allowedPlaces, sessionScope, visibleWorkOrders } from './scope';
import { PLAN_ASSIGNMENTS } from '../estate/planAssignments';
import type { EstateRaw, RawRow } from '../estate/types';

/**
 * The estate is the one read that must not truncate: a floor whose building was
 * dropped by paging vanishes from the model with no error. facilioHelpers caps
 * at 10 pages by default; the estate asks for the same 25 x 200 Estate
 * Navigator used, so both halves of the merge agree on the ceiling.
 */
const MAX_PAGES = 25;

async function list(action: string, payload: Record<string, unknown> = {}): Promise<RawRow[]> {
  return fetchAllPages<RawRow>(action, payload, { maxPages: MAX_PAGES });
}

/**
 * Inspections are the module most likely not to be enabled in a given org — and
 * an estate with no inspections panel is still a working estate. Every OTHER
 * list is a hard failure: no buildings means no model, and pretending otherwise
 * is exactly the silent-empty behaviour this file exists to remove.
 */
async function listInspectionsSoft(): Promise<{ rows: RawRow[]; unavailable: boolean }> {
  try {
    return { rows: await list('list-inspections'), unavailable: false };
  } catch (err) {
    console.warn('[estate] list-inspections unavailable:', (err as Error)?.message ?? err);
    return { rows: [], unavailable: true };
  }
}

/**
 * The CAD floor plans. Static bundled assets, not CMMS data — fetched with
 * BASE_URL rather than a hardcoded '/' so the app survives a sub-path deploy.
 * A missing or malformed plan degrades that floor to the schematic layout,
 * which is a real fallback, so these stay best-effort.
 */
async function loadPlans(): Promise<Record<string, unknown>> {
  const ids = [...new Set(PLAN_ASSIGNMENTS.map((a) => a.plan))];
  const out: Record<string, unknown> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}plans/${id}.json`);
        if (res.ok) out[id] = await res.json();
        else console.warn(`[estate] plan ${id}: HTTP ${res.status}`);
      } catch (err) {
        console.warn(`[estate] plan ${id} failed to load:`, (err as Error)?.message ?? err);
      }
    }),
  );
  return out;
}

/**
 * Every record the 3D estate needs, in one shot.
 *
 * Deliberately NOT `select`-projected: an invalid field in `select`/`expand`
 * nulls the whole response silently (docs/ROADMAP.md), and at this org's size
 * full rows are one page each. The narrow ASSET_SELECT stays on searchAssets,
 * where it serves the typing-hot path.
 */
export async function loadEstateRaw(showRetired = false): Promise<EstateRaw> {
  const [sites, buildings, floors, spaces, assets, workOrders, inspections, plans] =
    await Promise.all([
      // `expand: location` is what makes site coordinates arrive. The field is a
      // lookup, so without it the API returns a bare id — which is why this app
      // believed Facilio held no geo and shipped a manual lat/lng card instead.
      // Verified against the live org 2026-08-14: location expands to
      // {id, street, city, state, country, zip, lat, lng}. Deliberately NO
      // `select` here — an invalid field in select silently nulls the response.
      list('list-sites', { include_count: true, expand: 'location' }),
      list('list-buildings', { expand: 'site' }),
      list('list-floors', { expand: 'building,site' }),
      list('list-spaces', { expand: 'building,floor' }),
      list('list-assets', { expand: 'space,category,siteId' }),
      list('list-work-orders', { expand: 'resource,assignedTo,priority' }),
      listInspectionsSoft(),
      loadPlans(),
    ]);

  // The estate is its own work-order read path — it does not go through
  // listWorkOrders — so the assignment gate has to be applied here too, or the
  // 3D model would quietly show a technician every marker in the portfolio.
  const scopedWorkOrders = visibleWorkOrders(workOrders as AssigneeRow[]);
  const narrowed = narrowEstate(
    { sites, buildings, floors, spaces, assets },
    scopedWorkOrders,
  );

  return {
    sites: visibleRows(narrowed.sites, showRetired),
    buildings: visibleRows(narrowed.buildings, showRetired),
    floors: visibleRows(narrowed.floors, showRetired),
    spaces: visibleRows(narrowed.spaces, showRetired),
    assets: visibleRows(narrowed.assets, showRetired),
    workOrders: scopedWorkOrders as RawRow[],
    inspections: inspections.rows,
    inspectionsUnavailable: inspections.unavailable,
    plans,
  };
}

/** The estate rows this narrowing touches, in the raw shape the CMMS returns. */
type AssigneeRow = RawRow & { assignedTo?: unknown; resource?: { id?: number } };
type Lookup = { id?: number } | null | undefined;

/**
 * Reduce the estate to the places a technician's own work reaches. An admin
 * gets the arrays back untouched — same object, no copying, no cost.
 */
function narrowEstate(
  rows: { sites: RawRow[]; buildings: RawRow[]; floors: RawRow[]; spaces: RawRow[]; assets: RawRow[] },
  scopedWorkOrders: AssigneeRow[],
): { sites: RawRow[]; buildings: RawRow[]; floors: RawRow[]; spaces: RawRow[]; assets: RawRow[] } {
  if (sessionScope().role === 'admin') return rows;

  const assetIds = new Set<number>();
  for (const wo of scopedWorkOrders) {
    const id = wo.resource?.id;
    if (typeof id === 'number') assetIds.add(id);
  }

  // Map the raw rows into the flat shape allowedPlaces expects, so the walk
  // from asset → space → floor/building/site is the one rule, stated once.
  const places = allowedPlaces(
    rows.assets.map((a) => ({
      id: Number(a.id),
      name: String(a.name ?? ''),
      spaceId: (a.space as Lookup)?.id,
    })),
    rows.spaces.map((s) => ({
      id: Number(s.id),
      name: String(s.name ?? ''),
      siteId: (s.site as Lookup)?.id,
      buildingId: (s.building as Lookup)?.id,
      floorId: (s.floor as Lookup)?.id,
    })),
    assetIds,
  );

  return {
    // Sites narrow too. The 3D estate rendered every site's ground plane for a
    // technician who could only enter buildings in one of them.
    sites: rows.sites.filter((s) => places.siteIds.has(Number(s.id))),
    buildings: rows.buildings.filter((b) => places.buildingIds.has(Number(b.id))),
    floors: rows.floors.filter((f) => places.floorIds.has(Number(f.id))),
    spaces: rows.spaces.filter((s) => places.spaceIds.has(Number(s.id))),
    assets: rows.assets.filter((a) => assetIds.has(Number(a.id))),
  };
}
