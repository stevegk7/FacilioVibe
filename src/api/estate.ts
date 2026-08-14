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

  return {
    sites: visibleRows(sites, showRetired),
    buildings: visibleRows(buildings, showRetired),
    floors: visibleRows(floors, showRetired),
    spaces: visibleRows(spaces, showRetired),
    assets: visibleRows(assets, showRetired),
    workOrders,
    inspections: inspections.rows,
    inspectionsUnavailable: inspections.unavailable,
    plans,
  };
}
