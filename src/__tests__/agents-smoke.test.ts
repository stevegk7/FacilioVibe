// agents-smoke (WS-C): the four platform surprises the agent seam encodes, and
// the fabrication guard that keeps an invented id out of a write.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeAgent = vi.fn();
vi.mock('../api/vibe', () => ({ vibe: { executeAgent: (...args: unknown[]) => executeAgent(...args) } }));

import { clearAgentCache, contentOf, identifyAsset, orNone, stripFences } from '../api/agents';
import { runToolLoop } from '../voice/toolLoop';
import { fakeDeps } from './wsC-fakes';

// identifyAsset caches on (fileIds, candidate ids); these cases reuse both.
beforeEach(() => clearAgentCache());

describe('agent contract helpers', () => {
  it('contentOf throws when the reply has no text content', () => {
    expect(() => contentOf(undefined)).toThrow(/no text content/);
    expect(() => contentOf({})).toThrow(/no text content/);
    expect(() => contentOf({ response: {} })).toThrow(/no text content/);
    // the platform nests it, and it is a STRING even when it holds JSON
    expect(() => contentOf({ response: { content: { assetId: 1 } } })).toThrow();
    expect(contentOf({ response: { content: '{"assetId":1}' } })).toBe('{"assetId":1}');
  });

  it('stripFences handles plain, ``` and ```json', () => {
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
    expect(stripFences('  {"a":1}  ')).toBe('{"a":1}');
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    // an unterminated fence is not a fence
    expect(stripFences('```json\n{"a":1}')).toBe('```json\n{"a":1}');
  });

  it('orNone maps the "none" sentinel (schemas cannot union null)', () => {
    const table: Array<[unknown, string | undefined]> = [
      ['Acme', 'Acme'],
      ['  Acme  ', 'Acme'],
      ['none', undefined],
      ['None', undefined],
      ['NONE', undefined],
      ['null', undefined],
      ['', undefined],
      ['   ', undefined],
      [undefined, undefined],
      [null, undefined],
      [42, undefined],
    ];
    for (const [input, expected] of table) expect(orNone(input)).toBe(expected);
  });
});

describe('fabrication guard', () => {
  it('forces a verdict naming a non-candidate to no-match', async () => {
    executeAgent.mockResolvedValueOnce({
      response: { content: '```json\n{"assetId": 9999, "confidence": 0.97, "reason": "sure"}\n```' },
    });
    const verdict = await identifyAsset([7], [
      { id: 11, name: 'AHU-1' },
      { id: 12, name: 'AHU-2' },
    ]);
    expect(verdict.assetId).toBeNull();
    expect(verdict.confidence).toBeCloseTo(0.97);
  });

  it('keeps a verdict that names a supplied candidate', async () => {
    executeAgent.mockResolvedValueOnce({
      response: { content: '{"assetId":"12","confidence":0.5,"reason":"label match"}' },
    });
    const verdict = await identifyAsset([7], [
      { id: 11, name: 'AHU-1' },
      { id: 12, name: 'AHU-2' },
    ]);
    expect(verdict.assetId).toBe(12);
  });
});

describe('malformed agent replies never reach the UI as a throw', () => {
  it('treats un-parseable JSON as a final answer', async () => {
    const deps = fakeDeps({ voiceTurn: async () => '{"tool": "find_asset", ' });
    const result = await runToolLoop('what is that', {}, deps);
    expect(result.answer).toContain('{"tool"');
    expect(result.tools).toHaveLength(0);
  });

  it('turns a rejecting agent call into a spoken apology, not an exception', async () => {
    const deps = fakeDeps({
      voiceTurn: async () => {
        throw new Error('agent reply had no text content');
      },
    });
    const result = await runToolLoop('what is that', {}, deps);
    expect(result.answer).toMatch(/unavailable/i);
    expect(result.answer).toContain('no text content');
  });
});
