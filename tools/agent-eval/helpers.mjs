/**
 * The app's reply-parsing contract, in plain ESM so the eval harness can run
 * under bare `node` with no build step.
 *
 * These are deliberate mirrors of src/api/agents.ts (contentOf / stripFences /
 * orNone) and src/voice/toolLoop.ts (parseTool / num). The mirror is not taken
 * on trust: src/__tests__/agents-eval-helpers.test.ts imports BOTH copies and
 * asserts they agree case for case, so the eval scores what the app would see.
 */

/** The platform nests the reply at res.response.content, and it is a STRING. */
export function contentOf(res) {
  const content = res?.response?.content;
  if (typeof content !== 'string') throw new Error('agent reply had no text content');
  return content;
}

/** Models fence JSON in ``` blocks; an unterminated fence is not a fence. */
export function stripFences(text) {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : text.trim();
}

/** Schemas cannot union with null, so agents return the string 'none'. */
export function orNone(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return !text || text.toLowerCase() === 'none' || text.toLowerCase() === 'null'
    ? undefined
    : text;
}

/** Strict: fenced-or-plain `{...}` with a string `.tool`. Anything else → null. */
export function parseTool(reply) {
  let text = reply.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.tool !== 'string') return null;
    const args = parsed.args && typeof parsed.args === 'object' ? parsed.args : {};
    return { tool: parsed.tool, args };
  } catch {
    return null;
  }
}

/** Models emit ids as both numbers and numeric strings. */
export function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * `facilio vibe agent run` prints two progress lines and then the run envelope
 * as JSON. Slice from the first line-initial `{`.
 */
export function parseRunEnvelope(stdout) {
  const start = stdout.indexOf('\n{');
  if (start < 0) throw new Error(`no JSON in agent run output:\n${stdout}`);
  return JSON.parse(stdout.slice(start + 1));
}
