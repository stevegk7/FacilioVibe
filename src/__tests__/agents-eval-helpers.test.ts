// The eval harness scores replies with tools/agent-eval/helpers.mjs, a plain-ESM
// mirror of the app's parsers (it must run under bare `node`, with no build).
// A mirror that drifts scores something the app never sees, so this file
// imports BOTH copies and asserts they agree case for case.
import { describe, expect, it } from 'vitest';

import { contentOf, orNone, stripFences } from '../api/agents';
import { num, parseTool } from '../voice/toolLoop';
import * as evalHelpers from '../../tools/agent-eval/helpers.mjs';

const REPLIES = [
  '{"a":1}',
  '  {"a":1}  ',
  '```\n{"a":1}\n```',
  '```json\n{"a":1}\n```',
  '```json\n{"a":1}', // unterminated: not a fence
  '{"tool":"find_asset","args":{"name":"chiller 3"}}',
  '```json\n{"tool":"list_work_orders","args":{"assetId":"44"}}\n```',
  '{"tool":42,"args":{}}',
  '{"tool":"find_asset"}',
  '{"tool": "find_asset", ', // truncated JSON
  'Chiller 3 has one open work order.',
  '',
  '   ',
  'Here you go: {"tool":"find_asset","args":{}}',
];

const SENTINELS: unknown[] = ['Acme', '  Acme  ', 'none', 'None', 'NONE', 'null', '', '   ', undefined, null, 42];

const NUMBERS: unknown[] = [44, '44', ' 44 ', '44a', 'forty-four', '', null, undefined, NaN, -1, 0];

describe('the eval harness parses exactly what the app parses', () => {
  it('stripFences agrees on every reply shape', () => {
    for (const reply of REPLIES) {
      expect(evalHelpers.stripFences(reply)).toBe(stripFences(reply));
    }
  });

  it('parseTool agrees — including which replies are final answers', () => {
    for (const reply of REPLIES) {
      expect(evalHelpers.parseTool(reply)).toEqual(parseTool(reply));
    }
  });

  it('orNone agrees on the "none" sentinel table', () => {
    for (const value of SENTINELS) expect(evalHelpers.orNone(value)).toBe(orNone(value));
  });

  it('num agrees on ids emitted as numbers and as numeric strings', () => {
    for (const value of NUMBERS) expect(evalHelpers.num(value)).toBe(num(value));
  });

  it('contentOf agrees, including when it must throw', () => {
    const envelopes: unknown[] = [
      { response: { content: '{"a":1}' } },
      { response: { content: 'plain sentence' } },
      { response: {} },
      { response: { content: { a: 1 } } },
      {},
      undefined,
    ];
    for (const envelope of envelopes) {
      let mine: string | Error;
      let theirs: string | Error;
      try {
        mine = contentOf(envelope);
      } catch (err) {
        mine = err as Error;
      }
      try {
        theirs = evalHelpers.contentOf(envelope);
      } catch (err) {
        theirs = err as Error;
      }
      if (mine instanceof Error) {
        expect(theirs).toBeInstanceOf(Error);
        expect((theirs as Error).message).toBe(mine.message);
      } else {
        expect(theirs).toBe(mine);
      }
    }
  });
});

describe('the CLI run envelope', () => {
  it('is sliced off the progress lines `facilio vibe agent run` prints first', () => {
    const stdout = [
      '→ Running "fv-voice" in "facilio-vision"...',
      '  runId=—  threadId=—  status=completed',
      '{',
      '  "status": "completed",',
      '  "response": { "content": "{\\"tool\\":\\"find_asset\\",\\"args\\":{}}" }',
      '}',
    ].join('\n');
    const envelope = evalHelpers.parseRunEnvelope(stdout);
    expect(envelope.status).toBe('completed');
    expect(evalHelpers.parseTool(evalHelpers.contentOf(envelope))).toEqual({
      tool: 'find_asset',
      args: {},
    });
  });

  it('complains loudly rather than returning undefined when there is no JSON', () => {
    expect(() => evalHelpers.parseRunEnvelope('some CLI error')).toThrow(/no JSON/);
  });
});

describe('every fixture case is well formed', async () => {
  const { CASES } = await import('../../tools/agent-eval/fixtures.mjs');

  it('names a real agent, has an input, a check, a rationale and a counterexample', () => {
    const agents = ['fv-identify', 'fv-wo-draft', 'fv-nameplate', 'fv-voice', 'fv-tasks', 'fv-wayfinder'];
    for (const testCase of CASES) {
      expect(agents, testCase.name).toContain(testCase.agent);
      expect(typeof testCase.input, testCase.name).toBe('string');
      expect(testCase.input.length, testCase.name).toBeGreaterThan(0);
      expect(typeof testCase.expect, testCase.name).toBe('function');
      expect(typeof testCase.why, testCase.name).toBe('string');
      expect(typeof testCase.counterexample, testCase.name).toBe('string');
    }
  });

  it('uses unique case names — the summary table keys on them', () => {
    const names = CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // Every agent the app ships must be scored — an unscored agent is one whose
  // quality is an opinion. Keep this in step with AGENT_FILES in push.mjs.
  it('covers every agent the app deploys', () => {
    const covered = new Set(CASES.map((c) => c.agent));
    expect(covered.size).toBe(6);
  });

  // A check that can never fail scores nothing. Each fixture ships the exact
  // wrong reply it exists to catch, and the check must reject it.
  it('every check rejects its own counterexample', () => {
    for (const testCase of CASES) {
      const verdict = (() => {
        try {
          return testCase.expect(testCase.counterexample);
        } catch (err) {
          return (err as Error).message;
        }
      })();
      expect(verdict, `${testCase.name} accepted its counterexample`).not.toBe(true);
    }
  });
});
