#!/usr/bin/env node
/**
 * Push /agents definitions to the platform and verify the round-trip.
 *
 *   node tools/agent-eval/push.mjs            # push all four, then verify
 *   node tools/agent-eval/push.mjs fv-voice   # push one
 *
 * Verification is not cosmetic: the platform stores `role` and `instructions`
 * separately and PREPENDS "=== ROLE ===\n" to what it returns from `agent get`,
 * so a naive string compare always "fails". We compare the returned text with
 * that prefix stripped, and compare the schema structurally (the server
 * reorders object keys and drops nothing else).
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** name → instruction file, schema file (null = free-form text agent). */
export const AGENT_FILES = {
  'fv-identify': { txt: 'agents/identify.txt', schema: 'agents/identify.schema.json' },
  'fv-wo-draft': { txt: 'agents/wo-draft.txt', schema: 'agents/wo-draft.schema.json' },
  'fv-nameplate': { txt: 'agents/nameplate.txt', schema: 'agents/nameplate.schema.json' },
  'fv-tasks': { txt: 'agents/tasks.txt', schema: 'agents/tasks.schema.json' },
  'fv-wayfinder': { txt: 'agents/wayfinder.txt', schema: 'agents/wayfinder.schema.json' },
  // fv-voice must stay schema-less: its protocol is "JSON tool call OR a plain
  // spoken sentence", and a structured-output schema would force JSON always.
  'fv-voice': { txt: 'agents/voice.txt', schema: null },
};

const ROLE_PREFIX = '=== ROLE ===\n';

// The platform default for this org, and what every agent was authored and
// scored against. `agent create` needs them explicitly; `agent update` keeps
// whatever the agent already has.
const MODEL_PROVIDER = 'openai';
const MODEL_NAME = 'gpt-5.5';

async function facilio(args) {
  const { stdout } = await exec('facilio', args, { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** `agent get` prints two header lines, then the flow-ai record as JSON. */
export function parseGet(stdout) {
  const start = stdout.indexOf('\n{');
  if (start < 0) throw new Error(`no JSON in agent get output:\n${stdout}`);
  return JSON.parse(stdout.slice(start + 1));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortDeep(value[k])]),
    );
  }
  return value;
}

/** The agents this app's code calls, as the platform currently holds them. */
async function liveNames() {
  const out = await facilio(['vibe', 'agent', 'list']);
  return new Set(
    out
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((token) => token in AGENT_FILES),
  );
}

async function pushOne(name, existing) {
  const files = AGENT_FILES[name];
  const instructions = await readFile(resolve(ROOT, files.txt), 'utf8');

  // create and update take the same flags; only the verb and the "does it exist
  // yet" question differ. Provisioning a fresh app is therefore the same code
  // path as re-pushing a prompt, which is what keeps the two from drifting.
  const verb = existing.has(name) ? 'update' : 'create';
  const args = ['vibe', 'agent', verb, name, '--instructions', instructions.trim()];
  if (verb === 'create') args.push('--model-provider', MODEL_PROVIDER, '--model-name', MODEL_NAME);
  if (files.schema) args.push('--output-schema-file', resolve(ROOT, files.schema));
  await facilio(args);

  const record = parseGet(await facilio(['vibe', 'agent', 'get', name]));
  const problems = [];

  const live = String(record.instructions ?? '');
  const liveBody = live.startsWith(ROLE_PREFIX) ? live.slice(ROLE_PREFIX.length) : live;
  if (liveBody.trim() !== instructions.trim()) problems.push('instructions did not round-trip');

  if (files.schema) {
    const wanted = JSON.parse(await readFile(resolve(ROOT, files.schema), 'utf8'));
    const got = record.output_schema;
    if (JSON.stringify(sortDeep(wanted)) !== JSON.stringify(sortDeep(got))) {
      problems.push(
        `schema did not round-trip verbatim\n  sent: ${JSON.stringify(sortDeep(wanted))}\n  got:  ${JSON.stringify(sortDeep(got))}`,
      );
    }
  } else if (record.output_schema) {
    problems.push('expected no output schema on this agent');
  }

  return { name, model: `${record.model_provider}/${record.model_name}`, problems };
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(AGENT_FILES);
const existing = await liveNames();
let failed = 0;
for (const name of targets) {
  if (!AGENT_FILES[name]) {
    console.error(`unknown agent ${name}`);
    process.exitCode = 2;
    continue;
  }
  const { model, problems } = await pushOne(name, existing);
  if (problems.length) {
    failed++;
    console.log(`FAIL ${name} (${model})`);
    for (const p of problems) console.log(`     ${p}`);
  } else {
    console.log(`ok   ${name} (${model}) — instructions + schema verified verbatim`);
  }
}
process.exitCode = failed ? 1 : process.exitCode ?? 0;
