/**
 * Studio-agent seam. ALL model intelligence goes through the four app agents
 * (created via `facilio vibe agent`, definitions in /agents, eval harness in
 * tools/agent-eval — see docs/AGENTS.md):
 *
 *   fv-identify   — vision confirm: snap + candidate refs → {assetId|none, confidence, reason}
 *   fv-wo-draft   — photo + context → {subject, description, priority}
 *   fv-nameplate  — photo → {manufacturer, model, serial — 'none' where unreadable}
 *   fv-voice      — free-form utterance → final answer or {tool, args} (client-side loop)
 *
 * Contract helpers encode four platform surprises (learned in asset-lens):
 *  - the reply is at res.response.content and it is a STRING;
 *  - models fence JSON in ``` blocks — strip before parsing;
 *  - schemas can't union-type, so agents return the string "none", never null;
 *  - agents fabricate ids — a verdict must name a SUPPLIED candidate or it is
 *    forced to no-match, and they never get server-side tools.
 *
 * Four more defences live here, all of them client-side because the platform
 * gives us no server-side retry, validation or cancellation:
 *  - runStructured(): one parse-repair retry that re-asks with the parse error
 *    appended, then shape validation before anything is returned;
 *  - AgentError: every failure that is the agent's fault is typed, so callers
 *    can tell "the model misbehaved" from "the network died";
 *  - a small in-memory cache — the vision agents are pure functions of their
 *    file ids, so a re-render or a retap must not pay for a second inference;
 *  - a timeout / AbortSignal so a hung agent cannot freeze the UI. The platform
 *    call itself is not cancellable, so this rejects the caller's promise and
 *    lets the orphaned request die on its own.
 */
import { vibe } from './vibe';
import { isMockMode } from './provider';

export const IDENTIFY_AGENT = 'fv-identify';
export const WO_DRAFT_AGENT = 'fv-wo-draft';
export const NAMEPLATE_AGENT = 'fv-nameplate';
export const VOICE_AGENT = 'fv-voice';
export const TASKS_AGENT = 'fv-tasks';

/** Vision inference is slow; anything past this is a hung run, not a slow one. */
export const DEFAULT_AGENT_TIMEOUT_MS = 45_000;

export function contentOf(res: unknown): string {
  const content = (res as { response?: { content?: unknown } })?.response?.content;
  if (typeof content !== 'string') throw new Error('agent reply had no text content');
  return content;
}

export function stripFences(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : text.trim();
}

/** Agents are told to return the string 'none' rather than null. */
export function orNone(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return !text || text.toLowerCase() === 'none' || text.toLowerCase() === 'null'
    ? undefined
    : text;
}

export type AgentErrorKind =
  /** No text content came back at all. */
  | 'no-content'
  /** Both the first reply and the repair retry failed to parse as JSON. */
  | 'parse'
  /** Parsed, but the object does not satisfy the agent's contract. */
  | 'shape'
  /** The caller's timeout elapsed or its AbortSignal fired. */
  | 'timeout';

/** Thrown for every failure attributable to the agent rather than the network. */
export class AgentError extends Error {
  constructor(
    readonly agent: string,
    readonly kind: AgentErrorKind,
    message: string,
    /** The raw reply, when there was one — invaluable in a bug report. */
    readonly raw?: string,
  ) {
    super(`${agent}: ${message}`);
    this.name = 'AgentError';
  }
}

export interface AgentRunOptions {
  /** Abort the wait early (the platform run itself cannot be cancelled). */
  signal?: AbortSignal;
  /** Defaults to DEFAULT_AGENT_TIMEOUT_MS. 0 or Infinity disables the timer. */
  timeoutMs?: number;
  /** Skip the in-memory cache for this call (a deliberate "try again"). */
  noCache?: boolean;
}

export interface IdentifyVerdict {
  assetId: number | null;
  confidence: number;
  reason: string;
}

export interface WoDraft {
  subject: string;
  description: string;
  priority: 'High' | 'Medium' | 'Low';
  /** Proposed checklist (2-5 imperative steps). Optional: older agent
   * revisions and repaired replies may omit it — callers treat missing as []. */
  tasks?: string[];
}

export interface Nameplate {
  manufacturer?: string;
  model?: string;
  serial?: string;
}

// Mock replies keep every agent path developable offline (?mock=1).
const mock = {
  identify(candidateIds: number[]): IdentifyVerdict {
    return { assetId: candidateIds[0] ?? null, confidence: 0.82, reason: 'mock verdict' };
  },
  woDraft(): WoDraft {
    return {
      subject: 'Inspect equipment anomaly',
      description: 'Mock draft: visible wear on the housing; verify and schedule follow-up.',
      priority: 'Medium',
      tasks: ['Isolate equipment', 'Inspect housing wear', 'Record findings with photos'],
    };
  },
  suggestedTasks(): string[] {
    return ['Isolate power and lock out', 'Inspect and clean unit', 'Verify operation and record readings'];
  },
  nameplate(): Nameplate {
    return { manufacturer: 'Acme', model: 'AX-100', serial: 'SN-0042' };
  },
  voice(input: string): string {
    return `Mock reply to: ${input}`;
  },
};

// ── plumbing ───────────────────────────────────────────────────────────────

/**
 * Races the agent call against the caller's deadline. The underlying request
 * keeps running — there is no cancel on the platform — but the UI is freed.
 */
function withDeadline<T>(
  start: () => Promise<T>,
  agent: string,
  { signal, timeoutMs = DEFAULT_AGENT_TIMEOUT_MS }: AgentRunOptions,
): Promise<T> {
  // Checked before `start()` so an already-aborted caller never bills a run.
  if (signal?.aborted) {
    return Promise.reject(new AgentError(agent, 'timeout', 'aborted before the call started'));
  }
  const finite = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!finite && !signal) return start();

  const work = start();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () =>
      done(() => reject(new AgentError(agent, 'timeout', 'aborted by the caller')));
    const timer = finite
      ? setTimeout(
          () => done(() => reject(new AgentError(agent, 'timeout', `timed out after ${timeoutMs}ms`))),
          timeoutMs,
        )
      : undefined;

    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => done(() => resolve(value)),
      (err) => done(() => reject(err)),
    );
  });
}

async function callAgent(agent: string, prompt: string, fileIds?: number[]): Promise<string> {
  // Platform cap: at most 10 files per run.
  const res = await (fileIds?.length
    ? vibe.executeAgent(agent, prompt, { fileIds: fileIds.slice(0, 10) })
    : vibe.executeAgent(agent, prompt));
  return contentOf(res);
}

/**
 * executeAgent → contentOf → stripFences → JSON.parse, with ONE repair retry
 * that re-asks the agent with its own broken output and the parser's complaint
 * appended, then validates the shape. Everything that can go wrong here is the
 * agent's fault, so everything here throws AgentError.
 */
export async function runStructured<T>(
  agent: string,
  prompt: string,
  validate: (parsed: Record<string, unknown>, raw: string) => T,
  opts: AgentRunOptions & { fileIds?: number[] } = {},
): Promise<T> {
  const { fileIds, ...runOpts } = opts;

  const attempt = async (text: string): Promise<{ parsed?: Record<string, unknown>; raw: string; error?: string }> => {
    let raw: string;
    try {
      raw = await callAgent(agent, text, fileIds);
    } catch (err) {
      if (err instanceof AgentError) throw err;
      if (err instanceof Error && /no text content/.test(err.message)) {
        throw new AgentError(agent, 'no-content', err.message);
      }
      throw err; // network / SDK failure — not the agent's fault, pass it through
    }
    try {
      const parsed = JSON.parse(stripFences(raw)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { raw, error: 'reply parsed to something that is not a JSON object' };
      }
      return { parsed: parsed as Record<string, unknown>, raw };
    } catch (err) {
      return { raw, error: err instanceof Error ? err.message : 'JSON.parse failed' };
    }
  };

  const run = async (): Promise<T> => {
    let result = await attempt(prompt);
    if (result.error) {
      // One repair round trip. The agent sees exactly what it emitted and why
      // it did not parse — far more effective than re-asking the same prompt.
      result = await attempt(
        `${prompt}\n\nYour previous reply could not be parsed as JSON (${result.error}). ` +
          `It was:\n${result.raw.slice(0, 500)}\n` +
          `Reply again with the JSON object only — no prose, no markdown fence.`,
      );
    }
    if (!result.parsed) {
      throw new AgentError(agent, 'parse', result.error ?? 'unparseable reply', result.raw);
    }
    try {
      return validate(result.parsed, result.raw);
    } catch (err) {
      if (err instanceof AgentError) throw err;
      throw new AgentError(
        agent,
        'shape',
        err instanceof Error ? err.message : 'reply failed validation',
        result.raw,
      );
    }
  };

  return withDeadline(run, agent, runOpts);
}

/**
 * The vision agents are pure functions of their file ids, so the same tap
 * twice (a re-render, a back-and-forward, a retry after a UI hiccup) must not
 * bill a second inference. In-flight promises are cached too, which collapses
 * the duplicate calls a double-tap produces. Small and FIFO-evicted: this is a
 * per-session convenience, not a store.
 */
const CACHE_LIMIT = 32;
const cache = new Map<string, Promise<unknown>>();

/** Test/QA hook — the cache is per-session and never persisted. */
export function clearAgentCache(): void {
  cache.clear();
}

function cached<T>(key: string, opts: AgentRunOptions, run: () => Promise<T>): Promise<T> {
  if (opts.noCache) return run();
  const hit = cache.get(key);
  if (hit) return hit as Promise<T>;
  const promise = run();
  cache.set(key, promise);
  // A failure must not be remembered: the next tap should really retry.
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return promise;
}

// ── the four agents ────────────────────────────────────────────────────────

/**
 * Vision confirm. fileIds[0] MUST be the live snap; the rest are candidate
 * reference photos in candidate order. Max 10 files per run (platform cap).
 */
export async function identifyAsset(
  fileIds: number[],
  candidates: Array<{ id: number; name: string }>,
  opts: AgentRunOptions = {},
): Promise<IdentifyVerdict> {
  if (isMockMode()) return mock.identify(candidates.map((c) => c.id));
  const prompt =
    `The first image is the live camera snap. The remaining images are reference photos of the candidates, in this order:\n` +
    candidates.map((c, i) => `${i + 1}. id=${c.id} name=${c.name}`).join('\n');

  const key = `${IDENTIFY_AGENT}|${fileIds.join(',')}|${candidates.map((c) => c.id).join(',')}`;
  return cached(key, opts, () =>
    runStructured<IdentifyVerdict>(
      IDENTIFY_AGENT,
      prompt,
      (parsed) => {
        if (!('assetId' in parsed)) throw new Error('verdict has no assetId');
        if (typeof parsed.reason !== 'string') throw new Error('verdict has no reason string');
        const idText = orNone(String(parsed.assetId ?? ''));
        let assetId = idText !== undefined && /^\d+$/.test(idText) ? Number(idText) : null;
        // Fabrication guard: the verdict must name a supplied candidate.
        if (assetId !== null && !candidates.some((c) => c.id === assetId)) assetId = null;
        return {
          assetId,
          // Bounds are restated here because the schema's min/max are not
          // preserved server-side — the agent can and does exceed them.
          confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
          reason: parsed.reason,
        };
      },
      { ...opts, fileIds },
    ),
  );
}

export async function draftWorkOrder(
  fileId: number,
  context: string,
  opts: AgentRunOptions = {},
): Promise<WoDraft> {
  if (isMockMode()) return mock.woDraft();
  // Not cached: the technician re-drafting the same photo wants new words.
  return runStructured<WoDraft>(
    WO_DRAFT_AGENT,
    `CONTEXT: ${context}`,
    (parsed) => {
      const subject = typeof parsed.subject === 'string' ? parsed.subject.trim() : '';
      if (!subject) throw new Error('draft agent returned no subject');
      return {
        // The 80-char bound is instruction-only (schemas keep no maxLength),
        // so it is enforced here rather than hoped for.
        subject: subject.length > 120 ? `${subject.slice(0, 117)}...` : subject,
        description: typeof parsed.description === 'string' ? parsed.description : '',
        priority:
          parsed.priority === 'High' || parsed.priority === 'Low' ? parsed.priority : 'Medium',
        tasks: Array.isArray(parsed.tasks)
          ? parsed.tasks
              .map((t: unknown) => String(t ?? '').trim())
              .filter(Boolean)
              .slice(0, 5)
          : [],
      };
    },
    { ...opts, fileIds: [fileId] },
  );
}

/**
 * Checklist proposals for an EXISTING work order (fv-tasks). Text in, text
 * out — the app owns the ids and the write. Existing tasks ride along so the
 * agent proposes what is MISSING, never duplicates.
 */
export async function suggestTasks(
  wo: { subject: string; description?: string },
  assetName?: string,
  existing: string[] = [],
  opts: AgentRunOptions = {},
): Promise<string[]> {
  if (isMockMode()) return mock.suggestedTasks();
  const input = [
    `Work order: "${wo.subject}".`,
    wo.description ? `Description: ${wo.description}` : '',
    assetName ? `Asset: ${assetName}.` : '',
    `Existing tasks: ${existing.length ? existing.join('; ') : 'none'}.`,
  ]
    .filter(Boolean)
    .join(' ');
  const out = await runStructured<{ tasks: string[] }>(
    TASKS_AGENT,
    input,
    (parsed) => {
      const tasks = Array.isArray(parsed.tasks)
        ? parsed.tasks.map((t: unknown) => String(t ?? '').trim()).filter(Boolean)
        : [];
      if (tasks.length === 0) throw new Error('tasks agent returned no tasks');
      const have = new Set(existing.map((t) => t.toLowerCase()));
      return { tasks: tasks.filter((t) => !have.has(t.toLowerCase())).slice(0, 6) };
    },
    opts,
  );
  return out.tasks;
}

export async function readNameplate(
  fileId: number,
  opts: AgentRunOptions = {},
): Promise<Nameplate> {
  if (isMockMode()) return mock.nameplate();
  return cached(`${NAMEPLATE_AGENT}|${fileId}`, opts, () =>
    runStructured<Nameplate>(
      NAMEPLATE_AGENT,
      'Read the nameplate.',
      (parsed) => {
        for (const field of ['manufacturer', 'model', 'serial'] as const) {
          if (parsed[field] !== undefined && typeof parsed[field] !== 'string') {
            throw new Error(`${field} is not a string`);
          }
        }
        return {
          manufacturer: orNone(parsed.manufacturer),
          model: orNone(parsed.model),
          serial: orNone(parsed.serial),
        };
      },
      { ...opts, fileIds: [fileId] },
    ),
  );
}

/**
 * Field briefing: two sentences on the asset's state + ONE recommended next
 * action, spoken by the voice agent from the live work-order list. If the
 * model answers with a tool call (its other dialect) or dies, the caller gets
 * the DETERMINISTIC brief instead — a technician mid-job never sees an error
 * where a summary should be.
 */
export function localBrief(asset: { name: string }, wos: WorkOrderLite[]): string {
  const open = wos.filter((w) => !/closed|resolved/i.test(w.status ?? ''));
  if (open.length === 0) return `${asset.name} is clear — no open work orders.`;
  const oldest = open[open.length - 1];
  return `${asset.name} has ${open.length} open work order${open.length === 1 ? '' : 's'}. Start with #${oldest.id} — ${oldest.subject}.`;
}

export interface WorkOrderLite {
  id: number;
  subject: string;
  status?: string;
}

export async function briefAsset(
  asset: { id: number; name: string },
  wos: WorkOrderLite[],
  opts: AgentRunOptions = {},
): Promise<string> {
  const fallback = localBrief(asset, wos);
  if (isMockMode()) return fallback;
  const listing = wos
    .slice(0, 15)
    .map((w) => `#${w.id} "${w.subject}" [${w.status ?? 'unknown'}]`)
    .join('; ');
  try {
    const reply = await withDeadline(
      () =>
        callAgent(
          VOICE_AGENT,
          `Answer in plain text only (no JSON, no tool call). In at most two short sentences, brief a field technician on the state of asset "${asset.name}", then name the single most urgent next action. Its work orders: ${listing || 'none'}.`,
        ),
      VOICE_AGENT,
      opts,
    );
    // the voice agent's other dialect is a JSON tool call — that is not a brief
    if (/^\s*[{[]/.test(reply)) return fallback;
    return reply.trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Raw voice turn — the client-side tool loop in src/voice interprets the reply.
 * Deliberately NOT structured: the protocol is "a JSON tool call OR a plain
 * spoken sentence", which no output schema can express, so fv-voice carries no
 * schema and this returns the reply untouched.
 */
export async function voiceTurn(input: string, opts: AgentRunOptions = {}): Promise<string> {
  if (isMockMode()) return mock.voice(input);
  return withDeadline(
    async () => {
      try {
        return await callAgent(VOICE_AGENT, input);
      } catch (err) {
        if (err instanceof Error && /no text content/.test(err.message)) {
          throw new AgentError(VOICE_AGENT, 'no-content', err.message);
        }
        throw err;
      }
    },
    VOICE_AGENT,
    opts,
  );
}
