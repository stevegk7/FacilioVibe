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

/** Every (collection, key, value) this dataset owns. */
const rows = [
  { collection: 'settings', key: `wf.graph.${dataset.graph.siteId}`, value: dataset.graph },
  { collection: 'settings', key: `sitegeo.${dataset.sitegeo.siteId}`, value: dataset.sitegeo },
  ...dataset.surveys.map((s) => ({ collection: 'surveys', key: `survey.${s.id}`, value: s })),
  ...dataset.codes.map((c) => ({
    collection: 'codes',
    key: c.code.trim().toLowerCase(),
    value: c,
  })),
];

if (mode === 'check') {
  for (const row of rows) console.log(`${row.collection}/${row.key}`);
  console.log(`${rows.length} keys (dry run — nothing written)`);
  process.exit(0);
}

if (mode === 'sweep') {
  for (const row of rows) {
    const res = fvApi('kvDelete', { collection: row.collection, key: row.key });
    console.log(`deleted ${row.collection}/${row.key} existed=${res?.existed}`);
  }
  process.exit(0);
}

// The wayfinding graph is the one document a TEAMMATE might have authored by
// hand in the editor. Overwriting hand-drawn edges with demo data would be
// destructive — merge instead: demo nodes/edges are added only if their ids
// are absent, and everything human stays.
const existingGraph = fvApi('kvGet', {
  collection: 'settings',
  key: `wf.graph.${dataset.graph.siteId}`,
});
if (existingGraph?.value) {
  const current = JSON.parse(existingGraph.value);
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
  rows[0].value = dataset.graph;
  console.log('merged into the existing graph (hand-authored content preserved)');
}

for (const row of rows) {
  fvApi('kvPut', {
    collection: row.collection,
    key: row.key,
    value: JSON.stringify(row.value),
  });
  console.log(`put ${row.collection}/${row.key}`);
}

const counts = fvApi('health', {});
console.log('done —', JSON.stringify(counts?.counts));
