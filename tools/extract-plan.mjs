#!/usr/bin/env node
/* extract-plan.mjs — CLI over src/estate/planExtract.js.
 *
 * The extraction itself lives in that module because the APP does it too: a
 * facilities user importing a plan in the browser runs the same parser, the same
 * room recovery and the same cleaning as this command. Keeping the logic here and
 * a copy there is how the two quietly stop agreeing.
 *
 * Usage: node tools/extract-plan.mjs <in.svg> <out.json> --id <id> --name "Level 1"
 */
import fs from 'node:fs';
import { extractPlan, PlanExtractError } from '../src/estate/planExtract.js';

const args = process.argv.slice(2);
const [inFile, outFile] = args.filter((a) => !a.startsWith('--'));
const flag = (n, dflt) => {
  const i = args.indexOf('--' + n);
  return i >= 0 ? args[i + 1] : dflt;
};

if (!inFile || !outFile) {
  console.error('usage: node tools/extract-plan.mjs <in.svg> <out.json> --id <id> --name "Level 1"');
  process.exit(2);
}

let result;
try {
  result = extractPlan(fs.readFileSync(inFile, 'utf8'), {
    id: flag('id', 'plan'),
    name: flag('name', 'Floor plan'),
    source: inFile.split('/').pop(),
    cell: parseFloat(flag('cell', '0.05')),
    minArea: parseFloat(flag('minArea', '2.5')),
    seal: parseFloat(flag('seal', '0.6')),
  });
} catch (err) {
  if (err instanceof PlanExtractError) {
    console.error(`\n✗ ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const { plan, report } = result;
fs.writeFileSync(outFile, JSON.stringify(plan));

const seg = (a) => a.reduce((n, p) => n + p.length - 1, 0);
console.log(`\n${plan.name} — ${plan.widthM} x ${plan.depthM} m   ->  ${outFile}`);
console.log('  kept layers:');
for (const [k, v] of [...report.kept].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(v).padStart(7)}  ${k}`);
}
console.log('  polylines / segments per role:');
for (const r of Object.keys(plan.layers)) {
  console.log(`    ${r.padEnd(10)} ${String(plan.layers[r].length).padStart(6)} / ${seg(plan.layers[r])}`);
}
console.log(
  `  rooms detected: ${plan.rooms.length}  (total ${plan.rooms
    .reduce((n, r) => n + r.area, 0)
    .toFixed(0)} m² of ${(plan.widthM * plan.depthM).toFixed(0)} m² plate)`,
);
console.log('    ' + plan.rooms.slice(0, 14).map((r) => `${r.area}m²`).join('  '));
console.log('  dropped layers:');
for (const [k, v] of [...report.dropped].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${String(v).padStart(7)}  ${k}`);
}
console.log(`  output: ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);
