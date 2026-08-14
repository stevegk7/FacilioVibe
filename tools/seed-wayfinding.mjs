#!/usr/bin/env node
/**
 * Seed the LIVE demo wayfinding dataset into org #2915's KV via fvApi.
 *
 *   node --experimental-strip-types tools/seed-wayfinding.mjs           # seed
 *   node --experimental-strip-types tools/seed-wayfinding.mjs --check   # print, don't write
 *   node --experimental-strip-types tools/seed-wayfinding.mjs --sweep   # delete every demo key
 *
 * The dataset itself lives in src/wayfinding/demoData.ts (one builder, mock +
 * live universes) — this script only turns the LIVE universe into
 * `facilio vibe function run fvApi kvPut` calls. Guard rails:
 *   - refuses to run unless `facilio whoami` prints org #2915 (preview and
 *     production share one database; a live seed IS a production write)
 *   - kvPut is update-then-insert per key, so re-running is idempotent
 *   - every key carries the demo- prefix so --sweep can find them all
 */
import { execFileSync } from 'node:child_process';
import { buildDemoDataset, LIVE_DEMO_IDS } from '../src/wayfinding/demoData.ts';

const mode = process.argv.includes('--sweep')
  ? 'sweep'
  : process.argv.includes('--check')
    ? 'check'
    : 'seed';

function cli(args) {
  return execFileSync('facilio', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

function fvApi(handler, argsObj) {
  const out = cli(['vibe', 'function', 'run', 'fvApi', handler, '--args', JSON.stringify(argsObj)]);
  const brace = out.indexOf('{');
  return brace >= 0 ? JSON.parse(out.slice(brace)) : null;
}

// ---- guard: right org, function answering ----
const who = cli(['whoami']);
if (!who.includes('#2915')) {
  console.error('Refusing to seed: `facilio whoami` is not org #2915.\n' + who);
  process.exit(1);
}
const health = fvApi('health', {});
if (!health?.ok) {
  console.error('Refusing to seed: fvApi health did not answer ok.', health);
  process.exit(1);
}

const dataset = buildDemoDataset(LIVE_DEMO_IDS);

/**
 * Rows this dataset owns OUTRIGHT — every key is demo-only, so --sweep may
 * delete them wholesale.
 *
 * The two SHARED documents (wf.graph.<site> and sitegeo.<site>) are
 * deliberately NOT here: they are one-per-site records an admin also edits,
 * so they are merged on the way in and un-merged (not deleted) on the way out.
 */
const ownRows = [
  ...dataset.surveys.map((s) => ({ collection: 'surveys', key: `survey.${s.id}`, value: s })),
  ...dataset.codes.map((c) => ({
    collection: 'codes',
    key: c.code.trim().toLowerCase(),
    value: c,
  })),
];

const graphKey = `wf.graph.${dataset.graph.siteId}`;
const geoKey = `sitegeo.${dataset.sitegeo.siteId}`;

function readJson(collection, key) {
  const res = fvApi('kvGet', { collection, key });
  return res?.value ? JSON.parse(res.value) : null;
}

if (mode === 'check') {
  for (const row of ownRows) console.log(`${row.collection}/${row.key}`);
  console.log(`settings/${graphKey} (merged — demo nodes/edges only)`);
  console.log(`settings/${geoKey} (written only if absent)`);
  console.log(`${ownRows.length + 2} keys (dry run — nothing written)`);
  process.exit(0);
}

if (mode === 'sweep') {
  for (const row of ownRows) {
    const res = fvApi('kvDelete', { collection: row.collection, key: row.key });
    console.log(`deleted ${row.collection}/${row.key} existed=${res?.existed}`);
  }
  // Surgical: pull the demo nodes/edges back out and leave everything a human
  // drew. Deleting the whole document would destroy the very hand-authored
  // edges the seeder's merge went to the trouble of preserving.
  const current = readJson('settings', graphKey);
  if (current) {
    const demoNodeIds = new Set(dataset.graph.nodes.map((n) => n.id));
    const demoEdgeIds = new Set(dataset.graph.edges.map((e) => e.id));
    const kept = {
      ...current,
      nodes: (current.nodes ?? []).filter((n) => !demoNodeIds.has(n.id)),
      edges: (current.edges ?? []).filter((e) => !demoEdgeIds.has(e.id)),
    };
    if (kept.nodes.length || kept.edges.length) {
      fvApi('kvPut', { collection: 'settings', key: graphKey, value: JSON.stringify(kept) });
      console.log(`kept ${kept.nodes.length} nodes / ${kept.edges.length} hand-authored edges`);
    } else {
      fvApi('kvDelete', { collection: 'settings', key: graphKey });
      console.log(`deleted settings/${graphKey} (nothing hand-authored in it)`);
    }
  }
  console.log(`left settings/${geoKey} alone — site coordinates are not demo data`);
  process.exit(0);
}

// The wayfinding graph is the one document a TEAMMATE might have authored by
// hand in the editor. Overwriting hand-drawn edges with demo data would be
// destructive — merge instead: demo nodes/edges are added only if their ids
// are absent, and everything human stays.
const current = readJson('settings', graphKey);
if (current) {
  const nodeIds = new Set((current.nodes ?? []).map((n) => n.id));
  const edgeIds = new Set((current.edges ?? []).map((e) => e.id));
  dataset.graph.nodes = [
    ...(current.nodes ?? []),
    ...dataset.graph.nodes.filter((n) => !nodeIds.has(n.id)),
  ];
  dataset.graph.edges = [
    ...(current.edges ?? []),
    ...dataset.graph.edges.filter((e) => !edgeIds.has(e.id)),
  ];
  console.log('merged into the existing graph (hand-authored content preserved)');
}

for (const row of ownRows) {
  fvApi('kvPut', {
    collection: row.collection,
    key: row.key,
    value: JSON.stringify(row.value),
  });
  console.log(`put ${row.collection}/${row.key}`);
}

fvApi('kvPut', { collection: 'settings', key: graphKey, value: JSON.stringify(dataset.graph) });
console.log(`put settings/${graphKey}`);

// Site coordinates are REAL data an admin sets in Settings, and the demo's
// are a placeholder. Never overwrite a real fix with a placeholder — seed it
// only when the site has none, so the outdoor "Directions to site" leg works
// out of the box without lying about where the site is.
if (readJson('settings', geoKey)) {
  console.log(`kept existing settings/${geoKey} (admin-set coordinates win)`);
} else {
  fvApi('kvPut', { collection: 'settings', key: geoKey, value: JSON.stringify(dataset.sitegeo) });
  console.log(`put settings/${geoKey}`);
}

const counts = fvApi('health', {});
console.log('done —', JSON.stringify(counts?.counts));
