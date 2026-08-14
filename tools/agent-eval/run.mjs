#!/usr/bin/env node
/**
 * Repeatable eval for the four fv-* platform agents.
 *
 *   node tools/agent-eval/run.mjs                 # every case
 *   node tools/agent-eval/run.mjs fv-voice        # one agent
 *   node tools/agent-eval/run.mjs --grep final    # cases whose name matches
 *   node tools/agent-eval/run.mjs --repeat 3      # 3 samples per case (flakiness)
 *   node tools/agent-eval/run.mjs --json out.json # machine-readable results
 *
 * Every case is scored through the SAME parse helpers the app uses
 * (tools/agent-eval/helpers.mjs, kept honest against src/ by
 * src/__tests__/agents-eval-helpers.test.ts). Exit code is non-zero on any
 * regression, so this is CI-able.
 *
 * `facilio vibe agent run` is TEXT-ONLY: it cannot attach fileIds, so no case
 * sends an image. See the header of fixtures.mjs.
 */
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CASES } from './fixtures.mjs';
import { contentOf, parseRunEnvelope } from './helpers.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONCURRENCY = 4;

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const grep = flag('--grep', null);
const repeat = Number(flag('--repeat', 1));
const jsonOut = flag('--json', null);
const positional = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && !String(all[i - 1] ?? '').startsWith('--'));

const selected = CASES.filter(
  (c) =>
    (positional.length === 0 || positional.includes(c.agent)) &&
    (!grep || c.name.includes(grep)),
);

if (selected.length === 0) {
  console.error('no cases selected');
  process.exit(2);
}

async function runCase(testCase) {
  const started = Date.now();
  try {
    const { stdout } = await exec(
      'facilio',
      ['vibe', 'agent', 'run', testCase.agent, '--input', testCase.input],
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
    );
    const envelope = parseRunEnvelope(stdout);
    if (envelope.status !== 'completed') {
      return { ...base(testCase, started), pass: false, detail: `run status ${envelope.status}` };
    }
    const raw = contentOf(envelope);
    let verdict;
    try {
      verdict = testCase.expect(raw);
    } catch (err) {
      verdict = `check threw: ${err.message}`;
    }
    return {
      ...base(testCase, started),
      pass: verdict === true,
      detail: verdict === true ? '' : String(verdict),
      raw,
    };
  } catch (err) {
    return { ...base(testCase, started), pass: false, detail: `run failed: ${err.message}` };
  }
}

function base(testCase, started) {
  return { agent: testCase.agent, name: testCase.name, ms: Date.now() - started };
}

/** Fixed-size worker pool — the platform rate-limits hard parallelism. */
async function pool(items, size, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await worker(items[i], i);
    }),
  );
  return out;
}

const queue = [];
for (let sample = 0; sample < repeat; sample++) for (const c of selected) queue.push(c);

console.log(
  `running ${queue.length} agent call(s) — ${selected.length} case(s) x ${repeat} sample(s)\n`,
);
const results = await pool(queue, CONCURRENCY, runCase);

// ── summary ────────────────────────────────────────────────────────────────
const byName = new Map();
for (const r of results) {
  const row = byName.get(r.name) ?? { agent: r.agent, name: r.name, pass: 0, total: 0, ms: 0, fails: [] };
  row.total++;
  row.ms += r.ms;
  if (r.pass) row.pass++;
  else row.fails.push(r.detail);
  byName.set(r.name, row);
}

const width = Math.max(...[...byName.keys()].map((n) => n.length));
let failedCases = 0;
for (const row of byName.values()) {
  const ok = row.pass === row.total;
  if (!ok) failedCases++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(width)}  ${String(row.pass).padStart(2)}/${row.total}  ${String(Math.round(row.ms / row.total)).padStart(5)}ms`,
  );
  if (!ok) for (const d of [...new Set(row.fails)]) console.log(`      ↳ ${d}`);
}

const byAgent = new Map();
for (const row of byName.values()) {
  const a = byAgent.get(row.agent) ?? { pass: 0, total: 0 };
  a.pass += row.pass;
  a.total += row.total;
  byAgent.set(row.agent, a);
}
console.log('\nper agent:');
for (const [agent, a] of byAgent)
  console.log(`  ${agent.padEnd(13)} ${a.pass}/${a.total}  (${Math.round((100 * a.pass) / a.total)}%)`);

const passed = results.filter((r) => r.pass).length;
console.log(
  `\ntotal ${passed}/${results.length} samples (${Math.round((100 * passed) / results.length)}%), ${byName.size - failedCases}/${byName.size} cases clean`,
);

if (jsonOut) {
  await writeFile(resolve(ROOT, jsonOut), JSON.stringify({ results: [...byName.values()] }, null, 2));
  console.log(`wrote ${jsonOut}`);
}

process.exit(failedCases ? 1 : 0);
