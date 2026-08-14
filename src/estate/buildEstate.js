/* buildEstate.js — real Facilio CMMS records -> the shape estate-engine.js expects.
 *
 * PURE. No SDK, no fetch, no network: it takes raw record arrays in and returns
 * engine data out. Every read of `window` here is the vendored taxonomy that
 * src/estate/loadEngine.ts guarantees is present first (AssetTaxonomy /
 * FACILIO_ASSET_CATEGORIES / FACILIO_SPACE_CATEGORIES). The transport half now
 * lives behind the provider seam in src/api/estate.ts.
 *
 * WHAT IS REAL: sites, buildings, floors, spaces, assets, work orders,
 * inspections — every id, name, tagNumber, category, manufacturer, model,
 * description, and the whole site > building > floor > space > asset chain.
 *
 * WHAT IS SYNTHESIZED, AND WHY: Facilio's CMMS modules carry no indoor geometry
 * — no polygon, no floor plate size, no x/z for an asset. So footprints, room
 * polygons and equipment positions are LAID OUT from the real hierarchy: room
 * count per floor sets the plate width, each real space becomes one real room in
 * reading order, and each asset sits inside the real space it belongs to. Layout
 * is deterministic (seeded off record ids), so a record lands in the same place
 * on every reload. It is a schematic of real containment, not a measured survey
 * — labelled as such in the UI footer.
 *
 * Kept as JavaScript with a hand-written buildEstate.d.ts beside it. This is ~600
 * lines of seeded-hash numeric layout whose contract is guarded by
 * smoke-adapter.mjs and smoke-plan3d.mjs; converting it under `strict` +
 * `noUnusedLocals` would risk a silent geometry regression for no type benefit,
 * and Node has to be able to import it for those offline checks.
 */
import { PLAN_ASSIGNMENTS } from './planAssignments.js';
import { RETIRED_NAME as OBSOLETE } from '../api/recordPolicy.js';

/* ---------- helpers ---------- */


const id = (v) => (v && typeof v === 'object' ? v.id : v) ?? null;
const nameOf = (v) => (v && typeof v === 'object' ? v.name ?? v.displayName : v) ?? null;

function ms(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Stable 0..1 from an integer id — keeps layout identical across reloads. */
function hash01(n) {
  let x = (Number(n) ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- taxonomy resolution ---------- */

/** Real category name -> node in window.AssetTaxonomy (drives 3D model, colour, path). */
function taxNodeFor(categoryName) {
  const TX = window.AssetTaxonomy;
  if (!TX || !categoryName) return null;
  return TX.BY_ID[TX.slugify(categoryName)] || null;
}

function assetCatRow(categoryName) {
  const list = window.FACILIO_ASSET_CATEGORIES || [];
  if (!categoryName) return null;
  const lc = String(categoryName).toLowerCase();
  return list.find((c) => c.name === categoryName) || list.find((c) => c.name.toLowerCase() === lc) || null;
}

function spaceCatRow(categoryName) {
  const list = window.FACILIO_SPACE_CATEGORIES || [];
  if (!categoryName) return null;
  const lc = String(categoryName).toLowerCase();
  return list.find((c) => c.name === categoryName) || list.find((c) => c.name.toLowerCase() === lc) || null;
}

/* Equipment that belongs on a plant-room deck rather than in an office — same slug set the
   engine uses internally for PLANT_TAX. */
const PLANT_SLUGS = new Set(['chiller', 'cooling-tower', 'ahu', 'fahu', 'heat-pump', 'primary-pump',
  'secondary-pump', 'condenser-pump', 'chiller-plant-manager', 'refrigeration']);

/* ---------- layout constants (metres) ---------- */

const MARGIN = 1.4;       // gap between plate edge and room wall
const CORRIDOR = 3.2;     // central circulation spine
const ROOM_W = 6.6;       // nominal room width, sets plate width from room count
const DEPTH = 25;         // plate depth
const BAY = 3.9;          // spacing between equipment items inside a room

/* v5: one cool slate/blue family across the estate (the teal/amber/purple tints are gone) */
const TINTS = [
  { shellA: 0xe4ebfa, shellB: 0xd3e0f7, edge: 0x6e86c9, plinth: 0xcbd8f0, accent: '#4B6BD6' },
  { shellA: 0xe3eaf5, shellB: 0xd4dfef, edge: 0x7d92b8, plinth: 0xcedaeb, accent: '#5B7396' },
  { shellA: 0xe0eaf3, shellB: 0xd0deec, edge: 0x6f8cac, plinth: 0xcad9e8, accent: '#4A7292' },
  { shellA: 0xe6ecf7, shellB: 0xd8e2f2, edge: 0x8296c2, plinth: 0xd2dcee, accent: '#5F77B8' },
];

/* ---------- work-order status ---------- */

const CLOSED_STATES = /closed|resolved|cancel|complete/i;

const PRIORITY_RANK = { critical: 1, urgent: 1, high: 2, medium: 3, low: 4 };

function woPriority(row) {
  const p = String(nameOf(row.priority) ?? '').toLowerCase();
  return PRIORITY_RANK[p] ?? 3;
}

function woIsOpen(row) {
  return !CLOSED_STATES.test(String(nameOf(row.moduleState) ?? ''));
}

function woStatus(row) {
  if (!woIsOpen(row)) return 'closed';
  const due = ms(row.dueDate);
  return due && due < Date.now() ? 'overdue' : 'open';
}

/* ---------- loader ---------- */


/** Summary counts for the raw record lists — shared by the live loader and the dev harness. */
export function statsOf(raw) {
  return {
    sites: raw.sites.length,
    buildings: raw.buildings.length,
    floors: raw.floors.length,
    spaces: raw.spaces.length,
    assets: raw.assets.length,
    workOrders: raw.workOrders.length,
    openWorkOrders: raw.workOrders.filter(woIsOpen).length,
    inspections: raw.inspections.length,
    dropped: [...raw.buildings, ...raw.floors].filter((r) => OBSOLETE.test(r.name || '')).length,
  };
}

/* ---------- adapter: records -> engine data ---------- */

export function buildEstate(raw, opts = {}) {
  const { sampleHealth = false } = opts;
  const plans = raw.plans || {};
  /* floorRecordId -> planId, for plans imported against a specific floor. */
  const bindings = raw.planBindings || {};

  const keep = (r) => r && !OBSOLETE.test(r.name || '');

  const sites = (raw.sites || []).filter(keep);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));

  /* Site coordinates come from the CMMS `location` lookup (expanded in
     api/estate.ts), NOT from anything typed by hand. A site whose location is
     unset, or whose lat/lng are non-finite, is simply omitted — an absent site
     is an honest "no geo", whereas a 0,0 would price a route through the Gulf
     of Guinea. */
  const outSites = sites.map((s) => {
    const loc = s.location && typeof s.location === 'object' ? s.location : null;
    const lat = loc ? Number(loc.lat) : NaN;
    const lng = loc ? Number(loc.lng) : NaN;
    const hasGeo = Number.isFinite(lat) && Number.isFinite(lng);
    return {
      recordId: s.id,
      name: s.name,
      ...(hasGeo ? { lat, lng } : {}),
      ...(loc
        ? {
            address: [loc.street, loc.city, loc.state, loc.zip, loc.country]
              .filter(Boolean)
              .join(', '),
          }
        : {}),
    };
  });

  const buildings = (raw.buildings || []).filter(keep);
  const buildingIds = new Set(buildings.map((b) => b.id));

  const floors = (raw.floors || []).filter((f) => keep(f) && buildingIds.has(id(f.building)));
  const floorIds = new Set(floors.map((f) => f.id));

  const spaces = (raw.spaces || []).filter((s) => keep(s) && floorIds.has(id(s.floor)));
  const spaceById = new Map(spaces.map((s) => [s.id, s]));

  /* An asset's `space` lookup is polymorphic — it can point at a space, or straight at a site when
     the asset has no room assigned. Site-level assets are kept and placed on the circulation spine
     of their site's first building rather than dropped, and anything pointing somewhere we cannot
     resolve is counted in `unresolvedAssets` instead of silently vanishing.
     (In this org the only site-pointing records are 11 assets named "OBSOLETE (CLI test artifact)",
     which the obsolete filter above removes first, so this path currently takes nothing — it is
     here so a genuine site-level asset never disappears from the register.) */
  const siteIds = new Set(sites.map((s) => s.id));
  const roomAssets = [];
  const siteLevelBySite = new Map();
  let unresolvedAssets = 0;

  (raw.assets || []).filter(keep).forEach((a) => {
    const sid = id(a.space);
    if (spaceById.has(sid)) { roomAssets.push(a); return; }
    if (siteIds.has(sid)) {
      if (!siteLevelBySite.has(sid)) siteLevelBySite.set(sid, []);
      siteLevelBySite.get(sid).push(a);
      return;
    }
    unresolvedAssets++;
  });

  const assets = roomAssets;

  /* work orders indexed by the asset they point at */
  const woByAsset = new Map();
  const looseWos = [];
  (raw.workOrders || []).filter((w) => keep(w) && woIsOpen(w)).forEach((w) => {
    const rid = id(w.resource);
    if (rid == null) { looseWos.push(w); return; }
    if (!woByAsset.has(rid)) woByAsset.set(rid, []);
    woByAsset.get(rid).push(w);
  });

  /* inspections indexed by asset/resource */
  const inspByAsset = new Map();
  (raw.inspections || []).forEach((i) => {
    const rid = id(i.resource) ?? id(i.asset);
    if (rid == null) return;
    if (!inspByAsset.has(rid)) inspByAsset.set(rid, []);
    inspByAsset.get(rid).push({
      name: i.name || i.subject || 'Inspection',
      dueOn: ms(i.dueDate) ?? ms(i.scheduledStart) ?? Date.now(),
      status: woStatus(i) === 'overdue' ? 'overdue' : 'scheduled',
    });
  });

  /* ----- group hierarchy ----- */
  const floorsOfBuilding = new Map();
  floors.forEach((f) => {
    const b = id(f.building);
    if (!floorsOfBuilding.has(b)) floorsOfBuilding.set(b, []);
    floorsOfBuilding.get(b).push(f);
  });

  const spacesOfFloor = new Map();
  spaces.forEach((s) => {
    const f = id(s.floor);
    if (!spacesOfFloor.has(f)) spacesOfFloor.set(f, []);
    spacesOfFloor.get(f).push(s);
  });

  const assetsOfSpace = new Map();
  assets.forEach((a) => {
    const s = id(a.space);
    if (!assetsOfSpace.has(s)) assetsOfSpace.set(s, []);
    assetsOfSpace.get(s).push(a);
  });

  /* One asset record -> one engine marker. Shared by room-placed and site-level assets so both
     carry identical fields; only the placement differs. */
  function makeAssetMarker(a, place) {
    const catName = nameOf(a.category) || 'Devices';
    const node = taxNodeFor(catName);
    const catRow = assetCatRow(catName);
    const wos = woByAsset.get(a.id) || [];
    const worst = wos.reduce((acc, w) => {
      const st = woStatus(w);
      const p = woPriority(w);
      if (st === 'overdue' || p === 1) return 'critical';
      if (acc !== 'critical' && (st === 'open' || p === 2)) return 'overdue';
      return acc;
    }, 'healthy');

    return {
      recordId: a.id,
      markerModuleName: 'asset',
      code: a.tagNumber || (a.localId != null ? `#${a.localId}` : `#${a.id}`),
      name: a.name || catName,
      // Carried so "Find an asset" can match a scanned code. The raw row has had
      // it all along (loadEstateRaw sends no `select`); it was simply dropped here.
      qrVal: a.qrVal || null,
      description: a.description || '',
      category: catName,
      assetCategoryId: id(a.category),
      taxonomyId: node ? node.id : null,
      taxonomyName: node ? node.name : catName,
      taxonomyPath: node && window.AssetTaxonomy ? window.AssetTaxonomy.hierarchyPath(node.id) : catName,
      taxonomyType: node ? node.type : null,
      trade: catRow ? catRow.trade : node ? node.type : null,
      color: catRow ? catRow.color : node ? node.color : '#607796',
      modelLabel: node && window.PlantRoomModels ? window.PlantRoomModels.labelFor(node) : 'Equipment',
      manufacturer: a.manufacturer || null,
      model: a.model || null,
      serial: a.serialNumber || null,
      moduleState: nameOf(a.moduleState) || null,
      // no source in this org's records — left null, rendered as "—"
      condition: null,
      criticality: null,
      runHours: null,
      lastServicedOn: ms(a.commissionedTime) ?? ms(a.purchasedDate) ?? null,
      nextServiceDue: ms(a.warrantyExpiryDate) ?? null,
      status: worst,
      isPlant: node ? PLANT_SLUGS.has(node.id) : false,
      inspections: inspByAsset.get(a.id) || [],
      workOrders: wos.map((w) => w.id),
      spaceId: place.spaceId,
      spaceName: place.spaceName,
      placement: place.placement,
      rotationY: place.rotationY || 0,
      x: place.x,
      z: place.z,
      _wos: wos,
    };
  }

  /* a work-order pin sitting beside its asset */
  const woMarkersFor = (marker) => marker._wos.map((w, wi) => ({
    recordId: w.id,
    markerModuleName: 'workorder',
    subject: w.subject || 'Work order',
    trade: marker.trade,
    color: marker.color,
    priority: woPriority(w),
    status: woStatus(w),
    assetId: marker.recordId,
    assetName: marker.name,
    raisedAt: ms(w.createdTime) ?? Date.now(),
    dueOn: ms(w.dueDate),
    assignedTo: nameOf(w.assignedTo) || 'Unassigned',
    x: marker.x + 0.9 + wi * 0.5,
    z: marker.z + 0.9,
  }));

  /* ----- floor level: real floorlevel, ground (null) treated as 0 ----- */
  const levelOf = (f) => (typeof f.floorlevel === 'number' ? f.floorlevel : 0);
  const shortLabel = (f) => {
    const l = levelOf(f);
    return l === 0 ? 'G' : l < 0 ? 'B' + Math.abs(l) : 'L' + l;
  };

  /* ----- build each building ----- */
  const tintExtra = {};
  const outBuildings = [];
  const siteHandled = new Set();   // site-level plant attaches to the first building of its site

  buildings
    .slice()
    .sort((a, b) => (siteName.get(id(a.site)) || '').localeCompare(siteName.get(id(b.site)) || '') || a.name.localeCompare(b.name))
    .forEach((b, bi) => {
      const bFloors = (floorsOfBuilding.get(b.id) || []).slice().sort((x, y) => levelOf(x) - levelOf(y));
      if (!bFloors.length) return;

      const maxRooms = bFloors.reduce((n, f) => Math.max(n, (spacesOfFloor.get(f.id) || []).length), 0);
      const perZone = Math.max(1, Math.ceil(maxRooms / 2));
      const bid = String(b.id);

      /* a floor with a real plan sets the building's footprint — the plate has to be at least as
         big as the drawing, or the walls would poke through the shell */
      const planOf = (f) => {
        // A plan bound to this floor BY ID wins: it was imported against that
        // specific floor, whereas PLAN_ASSIGNMENTS matches on building and floor
        // NAMES and is only a default for the two plans that ship with the app.
        // Renaming a floor must not silently swap its drawing.
        // `f` is still a RAW cmms row here (the built floor's recordId is assigned
        // further down), so the Facilio id is f.id.
        const boundId = bindings[f.id];
        if (boundId && plans[boundId]) return plans[boundId];
        const hit = PLAN_ASSIGNMENTS.find((a) => a.building.test(b.name || '') && a.floor.test(f.name || ''));
        return hit ? plans[hit.plan] : null;
      };
      const planFloors = bFloors.map(planOf).filter(Boolean);
      const w = planFloors.length
        ? Math.max(...planFloors.map((p) => p.widthM)) + 0.8
        : clamp(2 * MARGIN + perZone * ROOM_W, 26, 64);
      const d = planFloors.length
        ? Math.max(...planFloors.map((p) => p.depthM)) + 0.8
        : DEPTH;

      tintExtra[bid] = TINTS[bi % TINTS.length];

      const outFloors = bFloors.map((f) => {
        const fSpaces = (spacesOfFloor.get(f.id) || [])
          .slice()
          .sort((x, y) => (x.name || '').localeCompare(y.name || ''));

        const plan = planOf(f);

        const floor = {
          recordId: f.id,
          name: shortLabel(f),
          floorlevel: levelOf(f),
          tenantId: null,
          tenantName: f.name || '',        // the real floor name ("Mechanical Floor")
          buildingName: b.name,
          siteName: siteName.get(id(f.site)) || siteName.get(id(b.site)) || '',
          _w: w,
          _d: d,
          plan: plan || null,
          spaces: [],
          markers: [],
        };

        if (plan) {
          /* Bind this floor's real Facilio spaces onto the plan's detected rooms, biggest room to
             biggest-first space, so a space you pick in the tree highlights an actual room with
             actual walls. Rooms beyond the space count stay as drawn geometry — real architecture
             the CMMS simply has no record for, which is worth showing rather than hiding. */
          fSpaces.forEach((s, i) => {
            const room = plan.rooms[i];
            if (!room) return;
            const cat = spaceCatRow(s.spaceCategory);
            floor.spaces.push({
              recordId: s.id,
              name: s.name || 'Space',
              spaceCategory: s.spaceCategory || 'Space',
              spaceCategoryId: cat ? cat.id : null,
              spaceGroup: cat ? cat.group : 'Common & Public',
              categoryColor: cat ? cat.color : '#9fb0c4',
              isOccupied: null,
              utilization: null,
              area: null,                 // Facilio holds none
              planArea: room.area,        // measured off the drawing — labelled as such in the UI
              buildingName: b.name,
              floorName: f.name || '',
              fromPlan: true,
              rects: room.rects,          // true room footprint, may be L-shaped
              centerX: room.cx,
              centerZ: room.cz,
              polygon: [
                [room.x0, room.z0], [room.x1, room.z0],
                [room.x1, room.z1], [room.x0, room.z1],
              ],
            });
          });
        }

        /* rooms: split the real spaces across the two zones either side of the corridor */
        const half = Math.ceil(fSpaces.length / 2);
        const zones = [
          { z0: -d / 2 + MARGIN, z1: -CORRIDOR / 2, list: fSpaces.slice(0, half) },
          { z0: CORRIDOR / 2, z1: d / 2 - MARGIN, list: fSpaces.slice(half) },
        ];

        (plan ? [] : zones).forEach((zone) => {
          const k = zone.list.length;
          if (!k) return;
          const x0 = -w / 2 + MARGIN;
          const span = w - 2 * MARGIN;
          // slight, stable width variation so rooms don't read as a perfect grid
          const weights = zone.list.map((s) => 0.85 + hash01(s.id) * 0.3);
          const total = weights.reduce((a, c) => a + c, 0);
          let acc = 0;
          zone.list.forEach((s, i) => {
            const xa = x0 + (acc / total) * span;
            acc += weights[i];
            const xb = x0 + (acc / total) * span;
            const cat = spaceCatRow(s.spaceCategory);
            floor.spaces.push({
              recordId: s.id,
              name: s.name || 'Space',
              spaceCategory: s.spaceCategory || 'Space',
              spaceCategoryId: cat ? cat.id : null,
              spaceGroup: cat ? cat.group : 'Common & Public',
              categoryColor: cat ? cat.color : '#9fb0c4',
              // not populated in this org — kept null rather than invented
              isOccupied: null,
              utilization: null,
              area: null,
              buildingName: b.name,
              floorName: f.name || '',
              polygon: [
                [xa + 0.15, zone.z0 + 0.15],
                [xb - 0.15, zone.z0 + 0.15],
                [xb - 0.15, zone.z1 - 0.15],
                [xa + 0.15, zone.z1 - 0.15],
              ],
            });
          });
        });

        /* equipment: positioned inside the real space it is assigned to */
        floor.spaces.forEach((sp) => {
          const inSpace = assetsOfSpace.get(sp.recordId) || [];
          if (!inSpace.length) return;

          /* A plan room can be L-shaped, so its bounding box includes ground that belongs to a
             wall or another room. Lay equipment out inside the room's largest rectangle instead;
             for a synthesised room the polygon bbox is already rectangular. */
          let bx0, bx1, bz0, bz1;
          if (sp.rects && sp.rects.length) {
            const big = sp.rects.reduce((a, r) =>
              (r[2] - r[0]) * (r[3] - r[1]) > (a[2] - a[0]) * (a[3] - a[1]) ? r : a);
            [bx0, bz0, bx1, bz1] = big;
          } else {
            const xs = sp.polygon.map((p) => p[0]);
            const zs = sp.polygon.map((p) => p[1]);
            bx0 = Math.min(...xs); bx1 = Math.max(...xs);
            bz0 = Math.min(...zs); bz1 = Math.max(...zs);
          }
          const inset = Math.min(1.0, (bx1 - bx0) / 4, (bz1 - bz0) / 4);
          const x0 = bx0 + inset, x1 = bx1 - inset, z0 = bz0 + inset, z1 = bz1 - inset;
          const iw = Math.max(0.5, x1 - x0);
          const idp = Math.max(0.5, z1 - z0);
          const cols = Math.max(1, Math.round(iw / BAY));
          const rows = Math.max(1, Math.ceil(inSpace.length / cols));

          inSpace
            .slice()
            .sort((p, q) => (p.tagNumber || p.name || '').localeCompare(q.tagNumber || q.name || ''))
            .forEach((a, i) => {
              const col = i % cols;
              const row = Math.floor(i / cols) % rows;
              const marker = makeAssetMarker(a, {
                spaceId: sp.recordId,
                spaceName: sp.name,
                placement: sp.spaceCategory || 'Space',
                x: x0 + (iw * (col + 0.5)) / cols,
                z: z0 + (idp * (row + 0.5)) / rows,
              });
              floor.markers.push(marker, ...woMarkersFor(marker));
            });
        });

        return floor;
      });

      /* site-level plant: no room to sit in, so it lands on the circulation spine of the lowest
         floor of the first building on that site, with spaceId null. The engine already renders
         spaceId-less markers on the corridor, and the tree groups them under "Unassigned space". */
      const bSiteId = id(b.site);
      if (bSiteId != null && !siteHandled.has(bSiteId) && siteLevelBySite.has(bSiteId) && outFloors.length) {
        siteHandled.add(bSiteId);
        const target = outFloors[0];
        siteLevelBySite.get(bSiteId)
          .slice()
          .sort((p, q) => (p.name || '').localeCompare(q.name || ''))
          .forEach((a, i) => {
            const side = i % 2 ? 1 : -1;
            const marker = makeAssetMarker(a, {
              spaceId: null,
              spaceName: 'Site-level plant',
              placement: `Site-level — no space assigned (${siteName.get(bSiteId) || 'site'})`,
              rotationY: side > 0 ? Math.PI : 0,
              x: clamp(-w / 2 + 3.5 + Math.floor(i / 2) * 3.6, -w / 2 + 1.5, w / 2 - 1.5),
              z: side * 1.15,
            });
            target.markers.push(marker, ...woMarkersFor(marker));
          });
      }

      outBuildings.push({
        id: bid,
        name: b.name,
        recordId: b.id,
        // siteId is declared in estate/types.ts and autoGraph keys its site nodes
        // on it — but it was never emitted here, so every site fell back to a
        // NAME key and could never match a `sitegeo.<numeric id>` document. That
        // is why cross-site routing was permanently unroutable.
        siteId: id(b.site),
        siteName: siteName.get(id(b.site)) || '',
        description: b.description || '',
        w,
        d,
        nF: outFloors.length,
        x: 0,
        z: 0,
        floors: outFloors,
      });
    });

  /* ----- place buildings on the ground plane, grouped by site ----- */
  const bySite = new Map();
  outBuildings.forEach((b) => {
    if (!bySite.has(b.siteName)) bySite.set(b.siteName, []);
    bySite.get(b.siteName).push(b);
  });

  let zCursor = 0;
  const rowGap = 30;
  const colGap = 16;
  const rowDepth = outBuildings.reduce((n, b) => Math.max(n, b.d), DEPTH);
  const siteRows = [...bySite.entries()];
  siteRows.forEach(([, group], si) => {
    const totalW = group.reduce((n, b) => n + b.w, 0) + colGap * (group.length - 1);
    let xCursor = -totalW / 2;
    group.forEach((b) => {
      b.x = xCursor + b.w / 2;
      b.z = zCursor;
      xCursor += b.w + colGap;
    });
    if (si < siteRows.length - 1) zCursor += rowDepth + rowGap;
  });
  /* centre the whole estate on the origin */
  const zMid = zCursor / 2;
  outBuildings.forEach((b) => { b.z -= zMid; });

  window.ESTATE_BUILDING_TINT_EXTRA = tintExtra;

  const name = sites.length === 1 ? sites[0].name : `Estate · ${siteRows.length} sites`;
  const placed = outBuildings.reduce(
    (n, b) => n + b.floors.reduce((k, f) => k + f.markers.filter((m) => m.markerModuleName === 'asset').length, 0), 0);

  const estate = {
    name,
    buildings: outBuildings,
    siteNames: siteRows.map(([s]) => s),
    /* Every site with its record id and, where the CMMS holds one, its
       coordinates — so the wayfinding graph can price a site-to-site hop and
       the outdoor deep link can name both ends without anyone typing a number. */
    sites: outSites,
    counts: {
      buildings: outBuildings.length,
      floors: outBuildings.reduce((n, b) => n + b.floors.length, 0),
      spaces: outBuildings.reduce((n, b) => n + b.floors.reduce((k, f) => k + f.spaces.length, 0), 0),
      assets: placed,
      siteLevelAssets: [...siteLevelBySite.values()].reduce((n, l) => n + l.length, 0),
      unresolvedAssets,
      planFloors: outBuildings.reduce((n, b) => n + b.floors.filter((f) => f.plan).length, 0),
      planRooms: outBuildings.reduce(
        (n, b) => n + b.floors.reduce((k, f) => k + (f.plan ? f.plan.rooms.length : 0), 0), 0),
    },
  };

  if (sampleHealth) applySampleHealth(estate);
  return estate;
}

/* ---------- optional sample health layer ----------
 * This org has 1 work order (a closed test record) and no operationalStatus, condition,
 * run-hours or service dates on any asset, so the design's health/jobs behaviour has nothing
 * real to render. Turning this on layers generated work orders and asset states over the REAL
 * hierarchy so the interaction can be reviewed. It is off by default and labelled in the UI.
 * Nothing here is written back to Facilio.
 */
export function applySampleHealth(estate) {
  const pickStatus = (h) => (h < 0.14 ? 'critical' : h < 0.34 ? 'overdue' : 'healthy');
  const SUBJECTS = {
    critical: ['%s tripped on high head pressure', '%s alarm — no flow detected', '%s shut down, awaiting attendance'],
    overdue: ['%s service overdue', '%s filter change due', '%s running outside setpoint'],
  };

  estate.buildings.forEach((b) => {
    b.floors.forEach((f) => {
      f.markers = f.markers.filter((m) => m.markerModuleName === 'asset');
      f.markers.forEach((a) => {
        const h = hash01(a.recordId * 7 + 13);
        a.status = pickStatus(h);
        a.condition = h < 0.14 ? 'poor' : h < 0.34 ? 'fair' : 'good';
        a.criticality = h < 0.2 ? 'High' : h < 0.55 ? 'Medium' : 'Low';
        a.runHours = Math.round(2000 + hash01(a.recordId * 3) * 46000);
        a.lastServicedOn = Date.now() - Math.round(hash01(a.recordId * 11) * 300) * 86400000;
        a.nextServiceDue = a.lastServicedOn + 180 * 86400000;
        a.workOrders = [];
        a.inspections = [];
        a._sample = true;
      });

      f.markers.slice().forEach((a) => {
        if (a.status === 'healthy') return;
        const crit = a.status === 'critical';
        const pool = SUBJECTS[crit ? 'critical' : 'overdue'];
        const pick = pool[Math.floor(hash01(a.recordId * 17) * pool.length)];
        const wo = {
          recordId: a.recordId * 100 + 1,
          markerModuleName: 'workorder',
          subject: pick.replace('%s', a.name),
          trade: a.trade,
          color: a.color,
          priority: crit ? 1 : 2,
          status: crit ? 'overdue' : 'open',
          assetId: a.recordId,
          assetName: a.name,
          raisedAt: Date.now() - Math.round(hash01(a.recordId * 23) * 72 * 3600000),
          dueOn: Date.now() + (crit ? -6 : 48) * 3600000,
          assignedTo: 'Unassigned',
          x: a.x + 0.9,
          z: a.z + 0.9,
          _sample: true,
        };
        a.workOrders = [wo.recordId];
        a.inspections = [{
          name: `${a.taxonomyName} scheduled inspection`,
          dueOn: Date.now() + Math.round(hash01(a.recordId * 29) * 30) * 86400000,
          status: crit ? 'overdue' : 'scheduled',
        }];
        f.markers.push(wo);
      });
    });
  });
  return estate;
}
