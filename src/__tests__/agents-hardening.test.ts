// The client-side defences in src/api/agents.ts: the parse-repair retry, shape
// validation, the fabrication guard, the purity cache, timeout/abort, and the
// mock-mode replies that keep every agent path developable offline.
//
// Entirely offline — vibe.executeAgent is mocked, so this file covers the
// image-bearing paths the eval harness cannot reach (`facilio vibe agent run`
// is text-only and has no way to attach fileIds).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeAgent = vi.fn();
vi.mock('../api/vibe', () => ({
  vibe: { executeAgent: (...args: unknown[]) => executeAgent(...args) },
}));

import {
  AgentError,
  clearAgentCache,
  draftWorkOrder,
  identifyAsset,
  readNameplate,
  resolveDestination,
  runStructured,
  voiceTurn,
} from '../api/agents';

/** The platform envelope: the reply is nested, and it is a STRING. */
const reply = (content: string) => ({ response: { content } });

const CANDIDATES = [
  { id: 11, name: 'AHU-1' },
  { id: 12, name: 'AHU-2' },
];

beforeEach(() => {
  clearAgentCache();
  executeAgent.mockReset();
  // Every test here runs against the real provider path.
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runStructured: the parse-repair retry', () => {
  it('re-asks once with the parse error appended, and accepts the repair', async () => {
    executeAgent
      .mockResolvedValueOnce(reply('Sure! Here you go: {"a": 1,'))
      .mockResolvedValueOnce(reply('{"a":1}'));

    const out = await runStructured('fv-test', 'PROMPT', (parsed) => parsed);
    expect(out).toEqual({ a: 1 });
    expect(executeAgent).toHaveBeenCalledTimes(2);

    const repairPrompt = executeAgent.mock.calls[1][1] as string;
    expect(repairPrompt).toContain('PROMPT');
    expect(repairPrompt).toMatch(/could not be parsed as JSON/);
    // the agent is shown its own broken output, which is what makes it fix it
    expect(repairPrompt).toContain('Sure! Here you go');
  });

  it('does not retry when the first reply parses', async () => {
    executeAgent.mockResolvedValueOnce(reply('```json\n{"a":1}\n```'));
    await runStructured('fv-test', 'PROMPT', (parsed) => parsed);
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });

  it('throws a typed parse AgentError when the repair also fails', async () => {
    executeAgent.mockResolvedValue(reply('still not json'));
    const err = await runStructured('fv-test', 'P', (p) => p).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe('parse');
    expect(err.agent).toBe('fv-test');
    expect(err.raw).toBe('still not json');
    expect(executeAgent).toHaveBeenCalledTimes(2);
  });

  it('treats a bare JSON array as unparseable — the contract is an object', async () => {
    executeAgent.mockResolvedValue(reply('[1,2,3]'));
    const err = await runStructured('fv-test', 'P', (p) => p).catch((e) => e);
    expect(err.kind).toBe('parse');
  });

  it('maps a missing text content to a no-content AgentError, with no retry', async () => {
    executeAgent.mockResolvedValue({ response: {} });
    const err = await runStructured('fv-test', 'P', (p) => p).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe('no-content');
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });

  it('lets a network failure through untouched — that is not the agent misbehaving', async () => {
    executeAgent.mockRejectedValue(new Error('NetworkError: fetch failed'));
    const err = await runStructured('fv-test', 'P', (p) => p).catch((e) => e);
    expect(err).not.toBeInstanceOf(AgentError);
    expect(err.message).toMatch(/NetworkError/);
  });
});

describe('validation rejects a reply that parsed but does not honour the contract', () => {
  it('identify: no reason string is a shape error', async () => {
    executeAgent.mockResolvedValue(reply('{"assetId":"11","confidence":0.9}'));
    const err = await identifyAsset([7], CANDIDATES).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe('shape');
    expect(err.message).toMatch(/no reason/);
  });

  it('identify: a missing assetId is a shape error, not a silent no-match', async () => {
    executeAgent.mockResolvedValue(reply('{"confidence":0.9,"reason":"looks right"}'));
    const err = await identifyAsset([7], CANDIDATES).catch((e) => e);
    expect(err.kind).toBe('shape');
  });

  it('wo-draft: an empty subject is a shape error', async () => {
    executeAgent.mockResolvedValue(reply('{"subject":"   ","description":"d","priority":"Low"}'));
    const err = await draftWorkOrder(5, 'ctx').catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe('shape');
    expect(err.message).toMatch(/no subject/);
  });

  it('wo-draft: a priority outside the enum falls back to Medium rather than throwing', async () => {
    executeAgent.mockResolvedValue(
      reply('{"subject":"Fix it","description":"d","priority":"CRITICAL"}'),
    );
    await expect(draftWorkOrder(5, 'ctx')).resolves.toMatchObject({ priority: 'Medium' });
  });

  it('nameplate: a non-string field is a shape error', async () => {
    executeAgent.mockResolvedValue(reply('{"manufacturer":{"name":"Acme"},"model":"X","serial":"1"}'));
    const err = await readNameplate(3).catch((e) => e);
    expect(err.kind).toBe('shape');
    expect(err.message).toMatch(/manufacturer/);
  });

  it('nameplate: the "none" sentinel becomes undefined, not the literal string', async () => {
    executeAgent.mockResolvedValue(
      reply('{"manufacturer":"CARRIER","model":"none","serial":"NONE"}'),
    );
    await expect(readNameplate(3)).resolves.toEqual({
      manufacturer: 'CARRIER',
      model: undefined,
      serial: undefined,
    });
  });
});

describe('fabrication guard survives the hardening', () => {
  it('forces an id outside the candidate list to no-match, keeping the confidence', async () => {
    executeAgent.mockResolvedValue(
      reply('{"assetId":"9999","confidence":0.97,"reason":"certain"}'),
    );
    const verdict = await identifyAsset([7], CANDIDATES);
    expect(verdict.assetId).toBeNull();
    expect(verdict.confidence).toBeCloseTo(0.97);
  });

  it('rejects a non-numeric assetId instead of coercing it to NaN', async () => {
    executeAgent.mockResolvedValue(reply('{"assetId":"AHU-2","confidence":0.9,"reason":"label"}'));
    await expect(identifyAsset([7], CANDIDATES)).resolves.toMatchObject({ assetId: null });
  });

  it('clamps confidence back into 0..1 — the schema bound is not enforced server-side', async () => {
    executeAgent.mockResolvedValue(reply('{"assetId":"12","confidence":95,"reason":"label"}'));
    await expect(identifyAsset([7], CANDIDATES)).resolves.toMatchObject({
      assetId: 12,
      confidence: 1,
    });
  });
});

describe('the purity cache', () => {
  it('serves a second identical identify from cache — one inference, not two', async () => {
    executeAgent.mockResolvedValue(reply('{"assetId":"12","confidence":0.8,"reason":"label"}'));
    const first = await identifyAsset([7, 8], CANDIDATES);
    const second = await identifyAsset([7, 8], CANDIDATES);
    expect(second).toEqual(first);
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });

  it('collapses two concurrent identical calls into one in-flight run', async () => {
    executeAgent.mockResolvedValue(reply('{"assetId":"12","confidence":0.8,"reason":"label"}'));
    await Promise.all([identifyAsset([7], CANDIDATES), identifyAsset([7], CANDIDATES)]);
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });

  it('misses when the file ids or the candidate set differ', async () => {
    executeAgent.mockResolvedValue(reply('{"assetId":"12","confidence":0.8,"reason":"label"}'));
    await identifyAsset([7], CANDIDATES);
    await identifyAsset([9], CANDIDATES);
    await identifyAsset([7], [CANDIDATES[0]]);
    expect(executeAgent).toHaveBeenCalledTimes(3);
  });

  it('caches nameplate reads per file id', async () => {
    executeAgent.mockResolvedValue(reply('{"manufacturer":"Acme","model":"X","serial":"1"}'));
    await readNameplate(42);
    await readNameplate(42);
    await readNameplate(43);
    expect(executeAgent).toHaveBeenCalledTimes(2);
  });

  it('noCache forces a fresh run', async () => {
    executeAgent.mockResolvedValue(reply('{"manufacturer":"Acme","model":"X","serial":"1"}'));
    await readNameplate(42);
    await readNameplate(42, { noCache: true });
    expect(executeAgent).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure — the next tap really retries', async () => {
    executeAgent.mockRejectedValueOnce(new Error('boom'));
    await expect(readNameplate(42)).rejects.toThrow('boom');
    executeAgent.mockResolvedValue(reply('{"manufacturer":"Acme","model":"X","serial":"1"}'));
    await expect(readNameplate(42)).resolves.toMatchObject({ manufacturer: 'Acme' });
    expect(executeAgent).toHaveBeenCalledTimes(2);
  });

  it('does not cache work order drafts — a redraft must produce new words', async () => {
    executeAgent.mockResolvedValue(reply('{"subject":"Fix","description":"d","priority":"Low"}'));
    await draftWorkOrder(5, 'ctx');
    await draftWorkOrder(5, 'ctx');
    expect(executeAgent).toHaveBeenCalledTimes(2);
  });
});

describe('timeout and abort keep a hung agent out of the UI', () => {
  it('rejects with a timeout AgentError once the deadline passes', async () => {
    vi.useFakeTimers();
    executeAgent.mockImplementation(() => new Promise(() => {})); // never settles
    const pending = readNameplate(1, { timeoutMs: 5_000 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_001);
    const err = await pending;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/timed out after 5000ms/);
  });

  it('rejects immediately when the caller aborts mid-flight', async () => {
    executeAgent.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = voiceTurn('hello', { signal: controller.signal }).catch((e) => e);
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/aborted by the caller/);
  });

  it('rejects without calling the platform when the signal is already aborted', async () => {
    const err = await voiceTurn('hello', { signal: AbortSignal.abort() }).catch((e) => e);
    expect(err.kind).toBe('timeout');
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('leaves no dangling timer behind on the happy path', async () => {
    vi.useFakeTimers();
    executeAgent.mockResolvedValue(reply('hello there'));
    await expect(voiceTurn('hi', { timeoutMs: 5_000 })).resolves.toBe('hello there');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('voiceTurn stays unstructured', () => {
  it('returns the reply untouched — the tool loop, not this seam, interprets it', async () => {
    executeAgent.mockResolvedValue(reply('{"tool":"find_asset","args":{"name":"chiller 3"}}'));
    await expect(voiceTurn('CONTEXT: siteId=1\nCOMMAND: find chiller 3')).resolves.toBe(
      '{"tool":"find_asset","args":{"name":"chiller 3"}}',
    );
  });

  it('does not attempt a JSON repair on a plain spoken sentence', async () => {
    executeAgent.mockResolvedValue(reply('Chiller 3 has one open work order.'));
    await expect(voiceTurn('anything')).resolves.toBe('Chiller 3 has one open work order.');
    expect(executeAgent).toHaveBeenCalledTimes(1);
  });

  it('sends no fileIds option when there are no files', async () => {
    executeAgent.mockResolvedValue(reply('ok'));
    await voiceTurn('hi');
    expect(executeAgent).toHaveBeenCalledWith('fv-voice', 'hi');
  });
});

describe('the platform file cap and prompt shape', () => {
  it('passes the snap first and truncates to the 10-file platform cap', async () => {
    executeAgent.mockResolvedValue(reply('{"assetId":"11","confidence":0.8,"reason":"r"}'));
    const fileIds = Array.from({ length: 14 }, (_, i) => i + 1);
    await identifyAsset(fileIds, CANDIDATES);
    const [, prompt, options] = executeAgent.mock.calls[0];
    expect((options as { fileIds: number[] }).fileIds).toHaveLength(10);
    expect((options as { fileIds: number[] }).fileIds[0]).toBe(1);
    expect(prompt).toContain('1. id=11 name=AHU-1');
    expect(prompt).toContain('2. id=12 name=AHU-2');
  });

  it('sends the CONTEXT line and the single photo to the draft agent', async () => {
    executeAgent.mockResolvedValue(reply('{"subject":"Fix","description":"d","priority":"High"}'));
    await draftWorkOrder(99, 'Fault reported at site HQ.');
    expect(executeAgent).toHaveBeenCalledWith(
      'fv-wo-draft',
      'CONTEXT: Fault reported at site HQ.',
      { fileIds: [99] },
    );
  });
});

describe('mock mode replies (?mock=1) never touch the platform', () => {
  beforeEach(() => window.history.replaceState({}, '', '/?mock=1'));

  it('identify returns the first candidate', async () => {
    await expect(identifyAsset([1], CANDIDATES)).resolves.toEqual({
      assetId: 11,
      confidence: 0.82,
      reason: 'mock verdict',
    });
  });

  it('identify with no candidates is a no-match', async () => {
    await expect(identifyAsset([1], [])).resolves.toMatchObject({ assetId: null });
  });

  it('wo-draft, nameplate and voice all answer offline', async () => {
    await expect(draftWorkOrder(1, 'ctx')).resolves.toMatchObject({ priority: 'Medium' });
    await expect(readNameplate(1)).resolves.toEqual({
      manufacturer: 'Acme',
      model: 'AX-100',
      serial: 'SN-0042',
    });
    await expect(voiceTurn('hello')).resolves.toBe('Mock reply to: hello');
    expect(executeAgent).not.toHaveBeenCalled();
  });
});

// The wayfinder assistant's guard rails. The agent answers with a LIST
// POSITION, never an id — so a fabricated destination is arithmetically
// impossible — and the client still refuses anything outside the range it
// offered, because clamping would silently answer a different question.
describe('resolveDestination: the wayfinder resolver', () => {
  const THREE = [
    { name: 'Chiller CH-1', where: 'Plant Room', openWorkOrders: 1 },
    { name: 'Chiller CH-2', where: 'Plant Room' },
    { name: 'Pump P-1', where: 'Pump Room' },
  ];

  it('maps a 1-based choice onto the caller\'s own array', async () => {
    executeAgent.mockResolvedValueOnce(
      reply('{"choice":"1","ask":"none","reason":"only chiller with an open job"}'),
    );
    await expect(resolveDestination('the chiller with the job', THREE)).resolves.toEqual({
      index: 0,
      ask: null,
      reason: 'only chiller with an open job',
    });
  });

  it('drops a position outside the offered range instead of clamping it', async () => {
    executeAgent.mockResolvedValueOnce(
      reply('{"choice":"9","ask":"none","reason":"invented a fourth option"}'),
    );
    const out = await resolveDestination('take me somewhere', THREE);
    expect(out.index).toBeNull();
  });

  it('keeps the disambiguation question only when nothing was picked', async () => {
    executeAgent.mockResolvedValueOnce(
      reply('{"choice":"none","ask":"CH-1 or CH-2?","reason":"two equal matches"}'),
    );
    await expect(resolveDestination('the chiller', THREE)).resolves.toMatchObject({
      index: null,
      ask: 'CH-1 or CH-2?',
    });

    executeAgent.mockResolvedValueOnce(
      reply('{"choice":"2","ask":"CH-1 or CH-2?","reason":"picked one anyway"}'),
    );
    // A pick AND a question is contradictory; the pick wins and the question
    // is dropped rather than shown under a route that is already set.
    await expect(resolveDestination('the chiller', THREE)).resolves.toMatchObject({
      index: 1,
      ask: null,
    });
  });

  it('never calls the platform when there is nothing to choose between', async () => {
    await expect(resolveDestination('anything', [])).resolves.toEqual({
      index: null,
      ask: null,
      reason: 'nothing in scope',
    });
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('answers offline in mock mode', async () => {
    window.history.replaceState({}, '', '/?mock=1');
    await expect(resolveDestination('the chiller', THREE)).resolves.toMatchObject({ index: 0 });
    expect(executeAgent).not.toHaveBeenCalled();
  });
});
