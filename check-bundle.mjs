#!/usr/bin/env node
/**
 * Bundle budget for the ENTRY chunk — `npm run check:bundle`, after a build.
 *
 * The merge's headline performance risk is that the 3D estate's cost leaks onto
 * the AR path. A phone in a plant room opens the camera and must not download
 * three.js (~149 KB gz), the four vendored estate globals (~30 KB gz), or the
 * 536 KB of CAD floor plans. All of those are behind dynamic imports and a
 * runtime script injector — but nothing except this check stops a stray static
 * `import 'three'` from silently pulling them back into the entry graph.
 *
 * So: assert the entry chunk stays under budget AND contains no three.js.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const DIST = 'dist';
const ASSETS = path.join(DIST, 'assets');
const BUDGET_GZ = 160 * 1024;

// A three.js build is unmistakable: these three symbols appear together in the
// renderer and nowhere else in this app's own source.
const THREE_MARKERS = ['WebGLRenderer', 'PerspectiveCamera', 'BufferGeometry'];

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

let html;
try {
  html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
} catch {
  fail('dist/index.html not found — run `npm run build` first.');
}

const match = /assets\/[\w.-]+\.js/.exec(html);
if (!match) fail('no entry chunk referenced from dist/index.html');
const entry = path.join(DIST, match[0]);

const source = readFileSync(entry);
const gz = gzipSync(source, { level: 9 }).length;

console.log(`\nentry: ${match[0]}`);
console.log(`  raw  ${source.length.toLocaleString()} B`);
console.log(`  gzip ${gz.toLocaleString()} B  (budget ${BUDGET_GZ.toLocaleString()} B)`);

const text = source.toString('utf8');
const three = THREE_MARKERS.filter((m) => text.includes(m));
if (three.length === THREE_MARKERS.length) {
  fail(
    `three.js is in the ENTRY chunk (${three.join(', ')}). It must stay behind ` +
      `the dynamic import in src/estate/loadEngine.ts, or every AR-only session ` +
      `downloads the whole 3D engine.`,
  );
}

if (gz > BUDGET_GZ) {
  fail(`entry chunk is ${(gz - BUDGET_GZ).toLocaleString()} B over the gzip budget.`);
}

// Informational: the lazy chunks, so a regression is legible rather than a mystery.
const others = readdirSync(ASSETS)
  .filter((f) => f.endsWith('.js') && !entry.endsWith(f))
  .map((f) => ({ f, gz: gzipSync(readFileSync(path.join(ASSETS, f)), { level: 9 }).length }))
  .sort((a, b) => b.gz - a.gz);
if (others.length) {
  console.log('\nlazy chunks:');
  for (const { f, gz: g } of others) console.log(`  ${g.toLocaleString().padStart(9)} B gz  ${f}`);
}

console.log('\nBUNDLE BUDGET OK\n');
