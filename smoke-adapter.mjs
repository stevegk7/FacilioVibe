/* Offline check: run buildEstate() over the org's REAL records (snapshotted into ./fixtures via
   `facilio connections execute facilio-cmms.list-*`) and assert the geometry contract that
   estate-engine.js relies on — polygons inside the plate, every asset inside its own room, every
   real category resolving to a 3D model, deterministic layout, and no record silently dropped.
   Run with: npm run check */
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://estate-navigator.vibe.facilio.com/',
  runScripts: 'outside-only',
});
global.window = dom.window;
global.document = dom.window.document;
// Node 21+ exposes `navigator` as a getter-only global, so a plain assignment
// throws and this check could not run at all on a current Node.
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
global.location = dom.window.location;

// design-project globals, loaded exactly as index.html loads them
for (const f of ['asset-category-taxonomy.js', 'plantroom-models.js', 'facilio-taxonomy.js', 'estate-engine.js']) {
  vm.runInContext(fs.readFileSync(`public/${f}`, 'utf8'), dom.getInternalVMContext(), { filename: f });
}
// mirror them onto the Node global the ESM module will see
for (const k of ['AssetTaxonomy', 'PlantRoomModels', 'FACILIO_ASSET_CATEGORIES', 'FACILIO_SPACE_CATEGORIES', 'FACILIO_TRADES', 'EstateEngine', 'makeEstateData']) {
  global.window[k] = dom.window[k];
}

const rows = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const raw = {
  sites: rows('list-sites.json'),
  buildings: rows('list-buildings.json'),
  floors: rows('list-floors.json'),
  spaces: rows('list-spaces.json'),
  assets: rows('list-assets.json'),
  workOrders: rows('list-work-orders.json'),
  inspections: rows('insp.json'),
  plans: Object.fromEntries(
    fs.readdirSync(new URL('./public/plans/', import.meta.url))
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(new URL(`./public/plans/${f}`, import.meta.url), 'utf8'))]),
  ),
};

const { buildEstate } = await import('./src/estate/buildEstate.js');
const { isRetired, visibleRows } = await import('./src/api/recordPolicy.js');

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL:', msg); } };

for (const sample of [false, true]) {
  const est = buildEstate(raw, { sampleHealth: sample });
  const bs = est.buildings;
  console.log(`\n=== sampleHealth=${sample} — "${est.name}" ===`);
  ok(bs.length > 0, 'has buildings');
  ok(!bs.some((b) => /obsolete/i.test(b.name)), 'obsolete building filtered out');

  let nSp = 0, nA = 0, nW = 0, unresolved = [], noModel = [];
  for (const b of bs) {
    ok(b.nF === b.floors.length, `${b.name}: nF matches floor count`);
    ok(Number.isFinite(b.x) && Number.isFinite(b.z), `${b.name}: has world position`);
    // a plan-driven plate is sized to the drawing, so the synthesised 26 m minimum won't apply
    const hasPlan = b.floors.some((f) => f.plan);
    ok(b.w >= (hasPlan ? 5 : 26) && b.d > 5, `${b.name}: has footprint (${b.w}x${b.d}${hasPlan ? ', plan-sized' : ''})`);

    const levels = b.floors.map((f) => f.floorlevel);
    ok(levels.every((l, i) => i === 0 || l >= levels[i - 1]), `${b.name}: floors stacked ascending`);

    for (const f of b.floors) {
      ok(typeof f.recordId === 'number', 'floor has recordId');
      ok(/^(G|B\d+|L\d+)$/.test(f.name), `floor label "${f.name}" is a level code`);
      for (const sp of f.spaces) {
        nSp++;
        ok(Array.isArray(sp.polygon) && sp.polygon.length === 4, `space ${sp.recordId}: 4-point polygon`);
        const xs = sp.polygon.map((p) => p[0]), zs = sp.polygon.map((p) => p[1]);
        ok(Math.min(...xs) >= -b.w / 2 - 0.01 && Math.max(...xs) <= b.w / 2 + 0.01, `space ${sp.name}: inside plate on x`);
        ok(Math.min(...zs) >= -b.d / 2 - 0.01 && Math.max(...zs) <= b.d / 2 + 0.01, `space ${sp.name}: inside plate on z`);
        ok(Math.max(...xs) - Math.min(...xs) > 0.5, `space ${sp.name}: non-degenerate width`);
        ok(!!sp.categoryColor, `space ${sp.name}: has colour`);
      }
      const spIds = new Set(f.spaces.map((s) => s.recordId));
      for (const m of f.markers) {
        if (m.markerModuleName === 'asset') {
          nA++;
          ok(Number.isFinite(m.x) && Number.isFinite(m.z), `asset ${m.code}: positioned`);
          // spaceId null == site-level plant on the corridor, which the engine supports
          ok(m.spaceId === null || spIds.has(m.spaceId), `asset ${m.code}: space resolves on its own floor`);
          if (m.spaceId === null) {
            ok(Math.abs(m.x) <= b.w / 2 && Math.abs(m.z) <= b.d / 2, `corridor asset ${m.code}: inside plate`);
          }
          if (!m.taxonomyId) unresolved.push(m.category);
          else if (!dom.window.PlantRoomModels || !dom.window.AssetTaxonomy.BY_ID[m.taxonomyId]) noModel.push(m.category);
        } else nW++;
      }
      // every room-placed asset must land inside its space's rectangle
      for (const m of f.markers.filter((x) => x.markerModuleName === 'asset' && x.spaceId !== null)) {
        const sp = f.spaces.find((s) => s.recordId === m.spaceId);
        if (!sp) continue;
        const xs = sp.polygon.map((p) => p[0]), zs = sp.polygon.map((p) => p[1]);
        ok(m.x >= Math.min(...xs) && m.x <= Math.max(...xs) && m.z >= Math.min(...zs) && m.z <= Math.max(...zs),
          `asset ${m.code}: inside room ${sp.name}`);
      }
    }
  }
  console.log(`  buildings=${bs.length} floors=${bs.reduce((n, b) => n + b.floors.length, 0)} spaces=${nSp} assets=${nA} woMarkers=${nW}`);
  console.log(`  counts: ${JSON.stringify(est.counts)}`);
  /* Every asset must be either rendered or explicitly a test artifact — nothing silently lost.
     The predicate comes from src/api/recordPolicy.js, the SAME module the providers apply, so
     this check fails the moment the two definitions drift apart. */
  const artifacts = raw.assets.filter(isRetired).length;
  ok(nA + artifacts === raw.assets.length,
    `all ${raw.assets.length} assets accounted for (rendered ${nA} + ${artifacts} test artifacts, got ${nA + artifacts})`);
  ok(est.counts.unresolvedAssets === 0, 'no asset dropped to an unresolvable parent');
  ok(!bs.some((b) => b.floors.some((f) => f.markers.some(isRetired))),
    'no test-artifact asset rendered');

  /* ---- real CAD floor plans ---- */
  const planFloors = bs.flatMap((b) => b.floors.filter((f) => f.plan).map((f) => ({ b, f })));
  ok(planFloors.length === Object.keys(raw.plans).length,
    `every sample plan is bound to a floor (${planFloors.length}/${Object.keys(raw.plans).length})`);
  for (const { b, f } of planFloors) {
    const p = f.plan;
    ok(b.w >= p.widthM && b.d >= p.depthM, `${b.name} plate ${b.w}x${b.d} covers plan ${p.widthM}x${p.depthM}`);
    ok(p.rooms.length > 0 && p.layers.walls.length > 0, `${p.name}: has rooms and walls`);
    ok(f.spaces.every((s) => s.fromPlan && s.rects && s.rects.length), `${p.name}: spaces bound to plan rooms`);
    ok(f.spaces.length === Math.min(p.rooms.length, f.spaces.length), `${p.name}: no space left unbound`);
    // room rectangles must sit on the plate and not overlap between rooms
    const all = f.spaces.flatMap((s) => s.rects);
    ok(all.every(([x0, z0, x1, z1]) =>
      x1 > x0 && z1 > z0 && Math.abs(x0) <= b.w / 2 + 0.5 && Math.abs(z1) <= b.d / 2 + 0.5),
      `${p.name}: room rects valid and inside the plate`);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [ax0, az0, ax1, az1] = all[i], [bx0, bz0, bx1, bz1] = all[j];
        const ov = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)) * Math.max(0, Math.min(az1, bz1) - Math.max(az0, bz0));
        if (ov > 0.01) { ok(false, `${p.name}: rooms overlap by ${ov.toFixed(2)} m²`); i = j = all.length; }
      }
    }
    // equipment on a plan floor must land inside one of its room's rectangles
    for (const m of f.markers.filter((x) => x.markerModuleName === 'asset' && x.spaceId !== null)) {
      const sp = f.spaces.find((s) => s.recordId === m.spaceId);
      if (!sp) continue;
      ok(sp.rects.some(([x0, z0, x1, z1]) => m.x >= x0 - 0.01 && m.x <= x1 + 0.01 && m.z >= z0 - 0.01 && m.z <= z1 + 0.01),
        `${p.name}: asset ${m.code} inside a real room rectangle`);
    }
    console.log(`  plan "${p.name}" on ${b.name}/${f.tenantName}: ${p.rooms.length} rooms, ` +
      `${f.spaces.length} bound to Facilio spaces, walls=${p.layers.walls.length} doors=${p.layers.doors.length}`);
  }
  console.log(`  unresolved categories: ${unresolved.length ? [...new Set(unresolved)].join(', ') : 'none'}`);
  console.log(`  categories without a 3D model: ${noModel.length ? [...new Set(noModel)].join(', ') : 'none'}`);
  ok(unresolved.length === 0, 'every real category resolves to a taxonomy node');

  // layout must be stable across rebuilds
  const again = buildEstate(raw, { sampleHealth: sample });
  const sig = (e) => JSON.stringify(e.buildings.map((b) => [b.id, b.x, b.z, b.floors.map((f) => f.spaces.map((s) => s.polygon))]));
  ok(sig(est) === sig(again), 'layout is deterministic across rebuilds');
}

// engine can actually consume it (three is stubbed out, so just check the data walk)
const est = buildEstate(raw, {});
ok(!!dom.window.ESTATE_BUILDING_TINT_EXTRA, 'tint overrides published for real building ids');
ok(Object.keys(dom.window.ESTATE_BUILDING_TINT_EXTRA).length === est.buildings.length, 'one tint per building');

/* ---- the record policy is applied exactly once ----
   The providers now filter retired records before buildEstate ever sees them, while buildEstate
   keeps its own defensive pass for callers like this one that feed raw fixtures directly. That is
   only safe if the filter is idempotent: pre-filtered input must produce a byte-identical estate.
   If it ever double-filters (or stops filtering), this is what catches it. */
const preFiltered = {
  ...raw,
  buildings: visibleRows(raw.buildings),
  floors: visibleRows(raw.floors),
  spaces: visibleRows(raw.spaces),
  assets: visibleRows(raw.assets),
};
const shape = (e) =>
  JSON.stringify(e.buildings.map((b) => [b.id, b.x, b.z, b.floors.map((f) => f.markers.map((m) => m.recordId))]));
ok(shape(buildEstate(preFiltered, {})) === shape(est),
  'record policy is idempotent — filtering upstream changes nothing downstream');
ok(visibleRows(raw.assets).length < raw.assets.length,
  'the fixtures still contain retired records, so the check above is meaningful');

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
