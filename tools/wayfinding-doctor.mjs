#!/usr/bin/env node
/**
 * Wayfinding doctor — is org #2915's portfolio actually routable, live?
 *
 *   node tools/wayfinding-doctor.mjs             # cached estate if fresh
 *   node tools/wayfinding-doctor.mjs --refresh   # re-pull every list from the CMMS
 *   node tools/wayfinding-doctor.mjs --json      # machine-readable summary as well
 *
 * STRICTLY READ-ONLY. The only CLI verbs it issues are `whoami`, `connections
 * execute facilio-cmms.list-*` and the fvApi kvGet/kvList/health handlers. It
 * never calls kvPut or kvDelete, so it is safe against the live org (preview and
 * production share one database — see tools/seed-wayfinding.mjs).
 *
 * It reimplements NOTHING. The estate comes out of src/estate/buildEstate.js and
 * the graph out of src/wayfinding/autoGraph.ts, exactly as WayfinderScreen builds
 * them — including the siteGeo merge (CMMS `location` expand as the source, the
 * `sitegeo.<id>` KV as the override). If the doctor says a route works, the app's
 * router agrees, because it is the same function.
 *
 * Node 20 has no --experimental-strip-types, so the two TypeScript modules are
 * bundled through the esbuild that already ships inside Vite (node_modules) into
 * one temp .mjs and imported from there. buildEstate.js is plain ESM and is
 * imported directly, after the vendored taxonomy globals are installed the way
 * smoke-adapter.mjs installs them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(os.tmpdir(), 'wayfinding-doctor-2915');
const CACHE_TTL_MS = 60 * 60 * 1000; // an hour — the estate does not move fast
const REFRESH = process.argv.includes('--refresh');
const AS_JSON = process.argv.includes('--json');

/* Same ceiling src/api/estate.ts uses. A floor whose building was dropped by
   paging vanishes from the model with no error, so the doctor must not truncate
   where the app would not. */
const MAX_PAGES = 25;
const PAGE_SIZE = 200;

const log = (...a) => console.log(...a);
const rule = (t) => log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

/* ---------------- CLI plumbing ---------------- */

function cli(args, { timeout = 180_000 } = {}) {
  return execFileSync('facilio', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
}

/** The CLI prints a status line before the payload; the payload starts at the first brace. */
function parseJson(out, what) {
  const brace = out.indexOf('{');
  if (brace < 0) throw new Error(`${what}: no JSON in CLI output:\n${out.slice(0, 400)}`);
  return JSON.parse(out.slice(brace));
}

function cmmsPage(action, params) {
  const out = cli([
    'connections',
    'execute',
    `facilio-cmms.${action}`,
    '--params',
    JSON.stringify(params),
  ]);
  return parseJson(out, action);
}

/** A single-row filter collapses `data` to an object — normalise, like rowsOf(). */
function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];
  return [];
}

function fetchAll(action, params) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = cmmsPage(action, { ...params, page, page_size: PAGE_SIZE });
    if (res && res.success === false) {
      throw new Error(`${action} failed: ${res.error?.message ?? 'unknown'}`);
    }
    const rows = rowsOf(res.data);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
  return all;
}

function fvApi(handler, argsObj) {
  const out = cli(['vibe', 'function', 'run', 'fvApi', handler, '--args', JSON.stringify(argsObj)]);
  return parseJson(out, `fvApi ${handler}`);
}

/* ---------------- guard: the right org ---------------- */

const who = cli(['whoami']);
if (!who.includes('#2915')) {
  console.error('Refusing to run: `facilio whoami` is not org #2915.\n' + who);
  process.exit(1);
}
log(who.trim());
log(`\nread-only — list-* + kvGet/kvList only, nothing is written`);

/* ---------------- estate: live, cached ---------------- */

fs.mkdirSync(CACHE_DIR, { recursive: true });

/* The exact action list and payloads loadEstateRaw() uses. `expand: location` is
   what makes site coordinates arrive at all; deliberately no `select`, because an
   invalid field in select silently nulls the whole response. */
const LISTS = [
  ['sites', 'list-sites', { include_count: true, expand: 'location' }],
  ['buildings', 'list-buildings', { expand: 'site' }],
  ['floors', 'list-floors', { expand: 'building,site' }],
  ['spaces', 'list-spaces', { expand: 'building,floor' }],
  ['assets', 'list-assets', { expand: 'space,category,siteId' }],
];

function cached(name, produce) {
  const file = path.join(CACHE_DIR, `${name}.json`);
  if (!REFRESH && fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < CACHE_TTL_MS) {
      log(`  ${name.padEnd(10)} cached  (${Math.round(age / 1000)}s old)`);
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  }
  const t0 = Date.now();
  const value = produce();
  fs.writeFileSync(file, JSON.stringify(value));
  log(`  ${name.padEnd(10)} live    (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return value;
}

rule('1. LIVE ESTATE');
log(`cache: ${CACHE_DIR}  (--refresh to re-pull)\n`);

const raw = {};
for (const [key, action, params] of LISTS) {
  raw[key] = cached(key, () => fetchAll(action, params));
}
raw.workOrders = cached('workOrders', () =>
  fetchAll('list-work-orders', { expand: 'resource,assignedTo,priority' }),
);
// Inspections are the module most likely not to be enabled; an estate without
// them is still an estate, so this stays soft exactly as loadEstateRaw has it.
raw.inspections = cached('inspections', () => {
  try {
    return fetchAll('list-inspections', {});
  } catch (err) {
    log(`  (list-inspections unavailable: ${err.message.split('\n')[0]})`);
    return [];
  }
});

/* The bundled CAD plans, keyed the way loadPlans() keys them. */
const planDir = path.join(ROOT, 'public', 'plans');
raw.plans = Object.fromEntries(
  fs
    .readdirSync(planDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(planDir, f), 'utf8'))]),
);

log(
  `\nrecords: sites=${raw.sites.length} buildings=${raw.buildings.length} floors=${raw.floors.length} ` +
    `spaces=${raw.spaces.length} assets=${raw.assets.length} workOrders=${raw.workOrders.length} ` +
    `inspections=${raw.inspections.length} bundledPlans=${Object.keys(raw.plans).length}`,
);

/* ---------------- the KV ---------------- */

rule('2. APP KV (fvApi)');

const health = fvApi('health', {});
log(`fvApi health: ${JSON.stringify(health)}`);

const settingsRows = cached('kv-settings', () =>
  fvApi('kvList', { collection: 'settings', prefix: '', limit: 500 }).rows ?? [],
);
const surveyRows = cached('kv-surveys', () =>
  fvApi('kvList', { collection: 'surveys', prefix: 'survey.', limit: 500 }).rows ?? [],
);

const parsed = (rows) =>
  rows.map((r) => {
    try {
      return { key: r.key, value: JSON.parse(r.value) };
    } catch {
      return { key: r.key, value: null };
    }
  });

const settings = parsed(settingsRows);
const surveys = parsed(surveyRows).filter((r) => r.value);
const under = (prefix) => settings.filter((r) => r.key.startsWith(prefix));

const geoRows = under('sitegeo.');
const planRows = under('plan.');
const handGraphRows = under('wf.graph.');
const overlayRows = under('wf.autograph.');

log(`settings keys: ${settings.length}`);
log(`  sitegeo.*        ${geoRows.length}   ${geoRows.map((r) => r.key).join(' ') || '—'}`);
log(`  plan.*           ${planRows.length}   ${planRows.map((r) => r.key).join(' ') || '—'}`);
log(`  wf.graph.*       ${handGraphRows.length}   ${handGraphRows.map((r) => r.key).join(' ') || '—'}`);
log(`  wf.autograph.*   ${overlayRows.length}   ${overlayRows.map((r) => r.key).join(' ') || '—'}`);
log(`surveys/survey.* : ${surveys.length} standpoints`);

// Plan geometry lives in the app FILE STORE, which has no CLI. The bindings are
// still authoritative for "does this floor have a plan", so they count toward
// coverage even though the doctor cannot load their rooms.
const kvBoundFloorIds = planRows
  .map((r) => Number(r.key.slice('plan.'.length)))
  .filter((n) => Number.isFinite(n));
if (kvBoundFloorIds.length) {
  log(
    `\nnote: ${kvBoundFloorIds.length} KV-bound plan document(s) live in the file store, which has ` +
      `no CLI — counted as coverage, but their room geometry is NOT in this run's graph.`,
  );
}

/* ---------------- the real builders ---------------- */

rule('3. BUILD (real buildEstate.js + real buildAutoGraph)');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://facilio-vision-3d.vibes.facilio.studio/',
  runScripts: 'outside-only',
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
global.location = dom.window.location;
for (const f of [
  'asset-category-taxonomy.js',
  'plantroom-models.js',
  'facilio-taxonomy.js',
]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), dom.getInternalVMContext(), {
    filename: f,
  });
}
for (const k of [
  'AssetTaxonomy',
  'PlantRoomModels',
  'FACILIO_ASSET_CATEGORIES',
  'FACILIO_SPACE_CATEGORIES',
  'FACILIO_TRADES',
]) {
  global.window[k] = dom.window[k];
}

/* Bundle the TypeScript half. Node 20 cannot strip types and autoGraph.ts has a
   value import of ./geo, so a bare dynamic import would not resolve either way. */
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-doctor-'));
const entry = path.join(bundleDir, 'entry.ts');
fs.writeFileSync(
  entry,
  `export { buildAutoGraph, routeOnGraph, siteOfNode } from ${JSON.stringify(path.join(ROOT, 'src/wayfinding/autoGraph.ts'))};\n` +
    `export { siteCoverage, unroutableAssets } from ${JSON.stringify(path.join(ROOT, 'src/wayfinding/coverage.ts'))};\n` +
    `export { haversineMeters } from ${JSON.stringify(path.join(ROOT, 'src/wayfinding/geo.ts'))};\n`,
);
const bundle = path.join(bundleDir, 'wf.mjs');
const esbuild = await import(path.join(ROOT, 'node_modules/esbuild/lib/main.js'));
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  logLevel: 'warning',
});

const { buildAutoGraph, routeOnGraph, siteCoverage, unroutableAssets, haversineMeters } =
  await import(bundle);
const { buildEstate } = await import(path.join(ROOT, 'src/estate/buildEstate.js'));
const { visibleRows } = await import(path.join(ROOT, 'src/api/recordPolicy.js'));

// The providers filter retired records before buildEstate sees them; do the same
// here so the doctor's estate is byte-identical to the app's.
const filtered = {
  ...raw,
  sites: visibleRows(raw.sites),
  buildings: visibleRows(raw.buildings),
  floors: visibleRows(raw.floors),
  spaces: visibleRows(raw.spaces),
  assets: visibleRows(raw.assets),
};

const built = buildEstate(filtered);
log(`estate "${built.name}" — counts: ${JSON.stringify(built.counts)}`);

/* siteGeo exactly as WayfinderScreen assembles it: CMMS location is the source,
   the sitegeo.<id> KV is the override. */
const fromCmms = {};
for (const s of built.sites ?? []) {
  if (typeof s.lat === 'number' && typeof s.lng === 'number') {
    fromCmms[String(s.recordId)] = { lat: s.lat, lng: s.lng };
  }
}
const fromKv = {};
for (const r of geoRows) {
  if (r.value && Number.isFinite(r.value.lat) && Number.isFinite(r.value.lng)) {
    fromKv[r.key.slice('sitegeo.'.length)] = { lat: r.value.lat, lng: r.value.lng };
  }
}
const siteGeo = { ...fromCmms, ...fromKv };
log(
  `siteGeo: ${Object.keys(fromCmms).length} from the CMMS location expand, ` +
    `${Object.keys(fromKv).length} KV override(s) → ${Object.keys(siteGeo).length} sites with coordinates`,
);

/* The KV wins the merge, by design — an admin's typed fix must beat a stale
   lookup. But the KV lane predates the `location` expand, so a row written back
   when the KV was the ONLY lane now silently overrides a real coordinate nobody
   knew existed. A disagreement of more than a couple of hundred metres is not a
   correction, it is a different place, and every outdoor distance and Maps deep
   link for that site is then fiction. Flag it; never "fix" it — this is read-only
   and only an admin can say which of the two is true. */
const GEO_CONFLICT_M = 250;
const geoConflicts = [];
for (const [key, kv] of Object.entries(fromKv)) {
  const cmms = fromCmms[key];
  if (!cmms) continue;
  const apart = haversineMeters(cmms, kv);
  if (apart > GEO_CONFLICT_M) geoConflicts.push({ key, cmms, kv, apart });
}
if (geoConflicts.length) {
  log(`\n!! ${geoConflicts.length} site(s) where the KV override CONTRADICTS the CMMS location:`);
  for (const c of geoConflicts) {
    const name = built.sites?.find((s) => String(s.recordId) === c.key)?.name ?? c.key;
    log(
      `   ${name} (${c.key}): CMMS ${c.cmms.lat.toFixed(5)},${c.cmms.lng.toFixed(5)} ` +
        `vs KV ${c.kv.lat.toFixed(5)},${c.kv.lng.toFixed(5)} — ${(c.apart / 1000).toFixed(1)} km apart. ` +
        `The KV wins, so every outdoor leg from this site is measured from the KV point.`,
    );
  }
}

const graph = buildAutoGraph(built, { siteGeo });
log(`\ngraph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

/* Accounting, so "0 unroutable assets" reads as a fact rather than a bug in this
   script: every raw asset is either retired, or in the graph, or unroutable. */
const RETIRED = /obsolete|safe to delete|\[fv-verify\]/i;
const retiredAssets = raw.assets.filter((a) => RETIRED.test(String(a.name ?? '')));
const assetNodeIds = new Set(
  graph.nodes.filter((n) => n.kind === 'asset').map((n) => n.recordId),
);
const inGraphCount = raw.assets.filter((a) => assetNodeIds.has(a.id)).length;
log(
  `assets: ${raw.assets.length} raw = ${retiredAssets.length} retired test artifacts ` +
    `+ ${inGraphCount} in the graph + ${raw.assets.length - retiredAssets.length - inGraphCount} unaccounted`,
);

const orphanSurveys = surveys.filter((r) => r.value?.siteId == null).length;
if (orphanSurveys) {
  log(
    `standpoints: ${orphanSurveys} of ${surveys.length} survey(s) carry no siteId, so they count ` +
      `toward no site and can never be offered as a starting point on one.`,
  );
}

/* ---------------- per-site attribution ---------------- */

const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
/* Keyed the way the graph keys its site nodes: record id when the building
   carries one, name otherwise. */
const siteKeyOfBuilding = new Map();
for (const e of graph.edges) {
  for (const [a, b] of [
    [e.from, e.to],
    [e.to, e.from],
  ]) {
    if (a.startsWith('building:') && b.startsWith('site:')) {
      siteKeyOfBuilding.set(Number(a.slice('building:'.length)), b.slice('site:'.length));
    }
  }
}
const siteKeyOfNode = (n) => {
  if (n.kind === 'site') return n.id.slice('site:'.length);
  if (n.buildingId != null) return siteKeyOfBuilding.get(n.buildingId) ?? null;
  return null;
};

const siteNodes = graph.nodes.filter((n) => n.kind === 'site');
const perSite = new Map();
for (const s of siteNodes) {
  perSite.set(s.id.slice('site:'.length), {
    key: s.id.slice('site:'.length),
    label: s.label,
    node: s,
    nodes: [],
    edges: [],
  });
}
const orphanNodes = [];
for (const n of graph.nodes) {
  const key = siteKeyOfNode(n);
  if (key != null && perSite.has(key)) perSite.get(key).nodes.push(n);
  else orphanNodes.push(n);
}
const crossSiteEdges = [];
for (const e of graph.edges) {
  const a = siteKeyOfNode(nodeById.get(e.from) ?? {});
  const b = siteKeyOfNode(nodeById.get(e.to) ?? {});
  if (a != null && a === b && perSite.has(a)) perSite.get(a).edges.push(e);
  else crossSiteEdges.push(e);
}

/* ---------------- coverage ---------------- */

const standpointsBySite = {};
for (const r of surveys) {
  const key = String(r.value?.siteId ?? 0);
  standpointsBySite[key] = (standpointsBySite[key] ?? 0) + 1;
}
const landmarksBySite = {};
for (const r of overlayRows) {
  landmarksBySite[r.key.slice('wf.autograph.'.length)] = Object.keys(
    r.value?.edgeNotes ?? {},
  ).length;
}

const coverage = siteCoverage(built, {
  boundFloorIds: kvBoundFloorIds,
  standpointsBySite,
  landmarksBySite,
});
const coverageByName = new Map(coverage.map((c) => [c.name, c]));

const unroutable = unroutableAssets(filtered, graph);

/* Which site an unroutable asset SHOULD have belonged to — walk asset → space →
   building → site over the raw rows, since the graph never got it. */
const idOf = (v) => (v && typeof v === 'object' ? v.id : v) ?? undefined;
const spaceById = new Map(raw.spaces.map((s) => [s.id, s]));
const buildingById = new Map(raw.buildings.map((b) => [b.id, b]));
const floorById = new Map(raw.floors.map((f) => [f.id, f]));
function siteOfRawAsset(a) {
  const sp = spaceById.get(idOf(a.space) ?? a.spaceId);
  if (!sp) return null;
  const direct = idOf(sp.site);
  if (direct != null) return String(direct);
  const b = buildingById.get(idOf(sp.building));
  if (b) return String(idOf(b.site) ?? '');
  const f = floorById.get(idOf(sp.floor));
  if (f) return String(idOf(f.site) ?? '');
  return null;
}

rule('4. PER-SITE READOUT');

const KINDS = ['site', 'building', 'floor', 'space', 'asset', 'core'];
const EDGE_KINDS = ['walk', 'door', 'stairs', 'outdoor'];

for (const site of [...perSite.values()].sort((a, b) => a.label.localeCompare(b.label))) {
  const cov = coverageByName.get(site.label);
  const nodeCounts = KINDS.map(
    (k) => `${k}=${site.nodes.filter((n) => n.kind === k).length}`,
  ).join(' ');
  const edgeCounts = EDGE_KINDS.map((k) => {
    const es = site.edges.filter((e) => e.kind === k);
    const bad = es.filter((e) => e.unroutable).length;
    return `${k}=${es.length}${bad ? `(${bad} unroutable)` : ''}`;
  }).join(' ');

  log(`\n■ ${site.label}   [${site.node.id}]`);
  log(`   nodes  ${site.nodes.length}: ${nodeCounts}`);
  log(`   edges  ${site.edges.length}: ${edgeCounts}`);
  const conflict = geoConflicts.find((c) => c.key === site.key);
  log(
    `   geo    ${site.node.geo ? `yes ${site.node.geo.lat.toFixed(5)},${site.node.geo.lng.toFixed(5)}` : 'NO — cannot take part in a site-to-site route'}` +
      `${fromKv[site.key] ? ' (KV override)' : site.node.geo ? ' (from CMMS location)' : ''}`,
  );
  if (conflict) {
    log(
      `          CONFLICT: the CMMS location record says ${conflict.cmms.lat.toFixed(5)},${conflict.cmms.lng.toFixed(5)} ` +
        `— ${(conflict.apart / 1000).toFixed(1)} km from the KV value the router is using`,
    );
  }
  if (cov) {
    log(
      `   floors ${cov.floors}, with a bound plan ${cov.floorsWithPlan}` +
        `${cov.floorsWithPlan < cov.floors ? ` — ${cov.floors - cov.floorsWithPlan} on synthesised geometry` : ''}`,
    );
    log(`   standpoints ${cov.standpoints}   landmarks ${cov.landmarks}`);
  } else {
    log(`   (no coverage row — the site has no buildings in the built estate)`);
  }
  const mine = unroutable.filter((u) => siteOfRawAsset(raw.assets.find((a) => a.id === u.id) ?? {}) === site.key);
  if (mine.length) {
    log(`   unroutable assets ${mine.length}:`);
    for (const u of mine) log(`     - ${u.name} (#${u.id}) — ${u.reason}`);
  }
}

if (orphanNodes.length) {
  log(`\n■ NOT ATTACHED TO ANY SITE: ${orphanNodes.length} node(s)`);
  for (const n of orphanNodes.slice(0, 20)) log(`   ${n.id}  ${n.kind}  ${n.label}`);
}
const orphanUnroutable = unroutable.filter((u) => {
  const key = siteOfRawAsset(raw.assets.find((a) => a.id === u.id) ?? {});
  return key == null || !perSite.has(key);
});
if (orphanUnroutable.length) {
  log(`\n■ UNROUTABLE ASSETS WITH NO RESOLVABLE SITE: ${orphanUnroutable.length}`);
  for (const u of orphanUnroutable) log(`   - ${u.name} (#${u.id}) — ${u.reason}`);
}

log(`\ncross-site edges: ${crossSiteEdges.length}`);
for (const e of crossSiteEdges) {
  log(
    `   ${e.from} → ${e.to}  ${e.kind} ${Number.isFinite(e.meters) ? `${Math.round(e.meters)}m` : '∞'}` +
      `${e.unroutable ? '  UNROUTABLE' : ''}`,
  );
}

/* ---------------- real sample routes ---------------- */

rule('5. REAL ROUTES (routeOnGraph)');

function show(title, fromId, toId) {
  log(`\n▸ ${title}`);
  if (!fromId || !toId) {
    log(`   SKIPPED — the graph contains no such pair`);
    return { title, skipped: true };
  }
  const from = nodeById.get(fromId);
  const to = nodeById.get(toId);
  log(`   from ${fromId}  "${from?.label}"`);
  log(`   to   ${toId}  "${to?.label}"`);
  const res = routeOnGraph(graph, fromId, toId);
  if (res.unroutable) {
    log(`   UNROUTABLE — ${res.reason}`);
    return { title, fromId, toId, unroutable: true, reason: res.reason };
  }
  log(`   OK — ${res.legs.length} leg(s), ${res.distanceM} m`);
  res.legs.forEach((l, i) => {
    log(
      `     ${i + 1}. ${l.kind.padEnd(8)} ${String(l.distanceM).padStart(7)} m  ${l.instruction}`,
    );
    log(`        ${l.nodes.join(' → ')}`);
  });
  return { title, fromId, toId, legs: res.legs.length, distanceM: res.distanceM };
}

const assetsByFloor = new Map();
const spacesByFloor = new Map();
for (const n of graph.nodes) {
  if (n.floorId == null) continue;
  if (n.kind === 'asset') {
    if (!assetsByFloor.has(n.floorId)) assetsByFloor.set(n.floorId, []);
    assetsByFloor.get(n.floorId).push(n);
  } else if (n.kind === 'space') {
    if (!spacesByFloor.has(n.floorId)) spacesByFloor.set(n.floorId, []);
    spacesByFloor.get(n.floorId).push(n);
  }
}

/* (a) within one floor: a space to an asset that is NOT in that space, so the
   route has to actually cross the plate rather than collapse to one hop. */
let withinFloor = [null, null];
for (const [floorId, assets] of assetsByFloor) {
  const spaces = spacesByFloor.get(floorId) ?? [];
  if (!spaces.length) continue;
  const pair = spaces
    .flatMap((sp) => assets.map((a) => [sp, a]))
    .find(([sp, a]) => a.spaceId != null && a.spaceId !== sp.recordId);
  if (pair) {
    withinFloor = [pair[0].id, pair[1].id];
    break;
  }
}

/* (b) two floors of one building. */
let acrossFloors = [null, null];
const floorsOfBuilding = new Map();
for (const n of graph.nodes) {
  if (n.kind !== 'floor' || n.buildingId == null) continue;
  if (!floorsOfBuilding.has(n.buildingId)) floorsOfBuilding.set(n.buildingId, []);
  floorsOfBuilding.get(n.buildingId).push(n);
}
const deepest = (floorId) =>
  (assetsByFloor.get(floorId) ?? [])[0] ?? (spacesByFloor.get(floorId) ?? [])[0] ?? null;
for (const [, floors] of floorsOfBuilding) {
  if (floors.length < 2) continue;
  const sorted = [...floors].sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  const lo = deepest(sorted[0].recordId);
  const hi = deepest(sorted[sorted.length - 1].recordId);
  if (lo && hi && lo.id !== hi.id) {
    acrossFloors = [lo.id, hi.id];
    break;
  }
}

/* (c) two buildings of one site. */
let acrossBuildings = [null, null];
for (const site of perSite.values()) {
  const buildings = [...new Set(site.nodes.filter((n) => n.kind === 'building').map((n) => n.recordId))];
  if (buildings.length < 2) continue;
  const pick = (bId) =>
    site.nodes.find((n) => n.kind === 'asset' && n.buildingId === bId) ??
    site.nodes.find((n) => n.kind === 'space' && n.buildingId === bId) ??
    site.nodes.find((n) => n.kind === 'building' && n.recordId === bId);
  const a = pick(buildings[0]);
  const b = pick(buildings[1]);
  if (a && b) {
    acrossBuildings = [a.id, b.id];
    break;
  }
}

/* (d) two sites. Deliberately picks the deepest node in each, because the
   interesting failure is the last outdoor hop, not the indoor walk to it. */
let acrossSites = [null, null];
const populated = [...perSite.values()].filter((s) => s.nodes.length > 1);
if (populated.length >= 2) {
  const deep = (s) =>
    s.nodes.find((n) => n.kind === 'asset') ??
    s.nodes.find((n) => n.kind === 'space') ??
    s.node;
  acrossSites = [deep(populated[0]).id, deep(populated[1]).id];
}

const routeResults = [
  show('within one floor (space → asset)', withinFloor[0], withinFloor[1]),
  show('across floors, one building', acrossFloors[0], acrossFloors[1]),
  show('across buildings, one site', acrossBuildings[0], acrossBuildings[1]),
  show('across sites', acrossSites[0], acrossSites[1]),
];

/* Every site pair, since the cross-site hop is the one that has historically
   been silently dead. */
log(`\n▸ every site pair, site node to site node`);
const siteList = [...perSite.values()];
for (let i = 0; i < siteList.length; i++) {
  for (let j = i + 1; j < siteList.length; j++) {
    const res = routeOnGraph(graph, siteList[i].node.id, siteList[j].node.id);
    log(
      `   ${siteList[i].label} → ${siteList[j].label}: ` +
        (res.unroutable ? `UNROUTABLE — ${res.reason}` : `${res.distanceM} m in ${res.legs.length} leg(s)`),
    );
  }
}

/* ---------------- gaps ---------------- */

rule('6. GAPS — what is missing, per site, in priority order');

const gapReport = [];
for (const site of [...perSite.values()].sort((a, b) => a.label.localeCompare(b.label))) {
  const cov = coverageByName.get(site.label);
  const gaps = [];

  if (!site.node.geo) {
    gaps.push({
      p: 1,
      what: 'No coordinates',
      fix: `Set the site's location (lat/lng) on the Facilio site record, or add a sitegeo.${site.key} override in Settings. Without it EVERY route that leaves this site is refused, not degraded.`,
    });
  }
  const conflict = geoConflicts.find((c) => c.key === site.key);
  if (conflict) {
    gaps.push({
      p: 0,
      what: `Coordinates disagree by ${(conflict.apart / 1000).toFixed(1)} km`,
      fix:
        `settings/sitegeo.${site.key} holds ${conflict.kv.lat.toFixed(5)},${conflict.kv.lng.toFixed(5)} and the CMMS ` +
        `location record holds ${conflict.cmms.lat.toFixed(5)},${conflict.cmms.lng.toFixed(5)}. The KV wins the merge, so ` +
        `every outdoor distance and every Maps deep link for this site is measured from the KV point. Decide which is true, ` +
        `then either correct the site's location in Facilio or delete the sitegeo override in Settings — do not leave both.`,
    });
  }
  const mine = unroutable.filter(
    (u) => siteOfRawAsset(raw.assets.find((a) => a.id === u.id) ?? {}) === site.key,
  );
  if (mine.length) {
    gaps.push({
      p: 2,
      what: `${mine.length} asset(s) not in the graph at all`,
      fix: `Cannot be found OR routed to: ${mine.map((u) => `${u.name} (${u.reason})`).join('; ')}`,
    });
  }
  if (site.nodes.filter((n) => n.kind === 'building').length === 0) {
    gaps.push({
      p: 3,
      what: 'No buildings',
      fix: 'The site is a destination but has nothing indoors — every route into it stops at the gate.',
    });
  }
  if (
    site.nodes.filter((n) => n.kind === 'building').length > 0 &&
    site.nodes.filter((n) => n.kind === 'asset').length === 0
  ) {
    gaps.push({
      p: 3,
      what: 'No assets on the graph',
      fix: 'The site has buildings but no equipment records, so a work order can never name a destination here — routes can only end at a room.',
    });
  }
  if (cov && cov.floorsWithPlan < cov.floors) {
    gaps.push({
      p: 4,
      what: `${cov.floors - cov.floorsWithPlan} of ${cov.floors} floor(s) have no bound plan`,
      fix: 'Those floors route through synthesised room boxes, so their distances are schematic, not measured. Import a plan per floor in the Estate screen.',
    });
  }
  if (cov && cov.standpoints === 0) {
    gaps.push({
      p: 5,
      what: 'No QR standpoints',
      fix: 'Nothing establishes which floor a technician is standing on, so a route can only start from a place they pick by hand.',
    });
  }
  if (cov && cov.landmarks === 0) {
    gaps.push({
      p: 6,
      what: 'No authored landmarks',
      fix: 'Every instruction is generated ("Walk to X"). Landmark phrasing is the single biggest accuracy win available and costs one sentence per edge.',
    });
  }
  const dead = site.edges.filter((e) => e.unroutable);
  if (dead.length) {
    gaps.push({ p: 1, what: `${dead.length} unroutable edge(s) inside the site`, fix: dead.map((e) => e.id).join(', ') });
  }

  log(`\n■ ${site.label}`);
  if (!gaps.length) log('   nothing missing — fully routable');
  gaps
    .sort((a, b) => a.p - b.p)
    .forEach((g, i) => {
      log(`   ${i + 1}. ${g.what}`);
      log(`      → ${g.fix}`);
    });
  gapReport.push({ site: site.label, gaps: gaps.sort((a, b) => a.p - b.p) });
}

log(`\n■ PORTFOLIO-WIDE`);
let n = 0;
const deadCross = crossSiteEdges.filter((e) => e.unroutable);
if (deadCross.length) {
  log(`   ${++n}. ${deadCross.length} site-to-site hop(s) unroutable for want of geo on one end`);
  for (const e of deadCross) log(`      → ${e.from} ↔ ${e.to}`);
}
if (geoConflicts.length) {
  log(`   ${++n}. ${geoConflicts.length} of ${Object.keys(fromKv).length} sitegeo overrides contradict the CMMS`);
  log(
    `      → Site-to-site distances are computed from the KV points, so the portfolio's whole outdoor ` +
      `layer is only as true as those rows. Reconcile the two lanes before anyone trusts a kilometre figure.`,
  );
}
if (orphanSurveys) {
  log(`   ${++n}. ${orphanSurveys} of ${surveys.length} standpoint(s) carry no siteId`);
  log(`      → They belong to no site, so they are never offered as a start on the site they were surveyed in.`);
}
if (kvBoundFloorIds.length) {
  log(`   ${++n}. ${kvBoundFloorIds.length} plan document(s) this run could not open`);
  const where = kvBoundFloorIds.map((id) => {
    const f = floorById.get(id);
    if (!f) return `floor ${id} (NO SUCH FLOOR — the binding is stale)`;
    const b = buildingById.get(idOf(f.building));
    return `${b ? `${b.name} / ` : ''}${f.name} (${id})`;
  });
  log(
    `      → ${where.join(', ')}. They are bound in settings/plan.* but the geometry lives in the app file ` +
      `store, which has no CLI — so those floors count as covered here while their plan-derived doorway edges ` +
      `go unverified. Only the 2 bundled plans in public/plans are in this run's graph.`,
  );
}
if (!n) log('   nothing');

log(`\ncache: ${CACHE_DIR}   (delete it or pass --refresh to re-pull the estate)`);

if (AS_JSON) {
  log(
    `\n${JSON.stringify(
      { coverage, unroutable, routes: routeResults, gaps: gapReport },
      null,
      2,
    )}`,
  );
}

fs.rmSync(bundleDir, { recursive: true, force: true });
