# The five fv-* agents

All model intelligence in facilio-vision-3d goes through five Studio agents on
the platform (org #2915, app `facilio-vision-3d`). They are **prompt-configured**,
not trained: there is no fine-tuning API behind `facilio vibe agent`. "Tuning"
here means instructions, schemas, client-side validation, and a scored eval
harness that makes the quality a number instead of an opinion.

| agent          | id   | schema                      | consumed by |
| -------------- | ---- | --------------------------- | ----------- |
| `fv-identify`  | 6366 | `agents/identify.schema.json`  | `identifyAsset()` → `src/voice/reportFault.ts` |
| `fv-wo-draft`  | 6367 | `agents/wo-draft.schema.json`  | `draftWorkOrder()` → `reportFault.ts`, `ARScreen` |
| `fv-nameplate` | 6368 | `agents/nameplate.schema.json` | `readNameplate()` |
| `fv-tasks`     | 6369 | `agents/tasks.schema.json`     | `suggestTasks()` → `src/ar/ArWindow.tsx` |
| `fv-voice`     | 6370 | **none, deliberately**      | `voiceTurn()` → `src/voice/toolLoop.ts` |

Live model: `openai / gpt-5.5` on all five (not claude — check with
`facilio vibe agent get <name>` before assuming).

> The ids above are this app's. Agents are **app-scoped**: the platform
> `link_name` embeds the app UUID (`fv-identify_455651cc…`), so `facilio-vision`
> holds a separate set under its own ids. Only the *names* are shared, and those
> are what `src/api/agents.ts` calls — which is why the merge needed no app-code
> change. Provision a fresh app with `node tools/agent-eval/push.mjs`, which
> creates what is missing, updates what exists, and verifies the round-trip.

Source of truth is `/agents/*.txt` + `*.schema.json` in this repo. The platform
copy is a deployment of those files; never edit an agent in the UI.

---

## Per-agent contract

### fv-identify — vision confirm

**In**: the live snap as `fileIds[0]`, then one reference photo per candidate in
candidate order (10 files max, a platform cap). Prompt numbers the candidates as
`N. id=<id> name=<name>`.

**Out**: `{assetId, confidence, reason}`. `assetId` is a candidate id **as a
string**, or the sentinel `"none"` — schemas cannot union with `null`, which is
why every optional value in this codebase is the string `"none"`.

**Failure modes it is written against**
- *Id fabrication.* It will confidently return an id nobody offered it,
  especially when the prompt asserts one. Instructions forbid it; `identifyAsset`
  enforces it anyway (any id not in `candidates` is forced to `null`), because a
  work order raised on the wrong asset is worse than one more tap.
- *Confidence inflation.* `minimum`/`maximum` are **not preserved server-side**,
  so the bound is restated in the instructions and clamped in the client. The
  agent still occasionally answers on a 0–100 scale.
- *Guessing in the dark.* Blur, darkness and "no images at all" must all be
  `"none"` at confidence 0.

### fv-wo-draft — fault photo → work order words

**In**: one photo plus a `CONTEXT:` line of **names** (site / space / asset /
survey) built by `faultContext()`. Never ids: the app, not the agent, decides
which asset the work order lands on.

**Out**: `{subject, description, priority}`, priority from the enum
`High | Medium | Low`.

**Failure modes**
- *Invented specifics* — part numbers, WO numbers, dates, readings. Rule 1 bans
  them; the `resists-injected-priority-and-numbers` case checks the agent does
  not echo a number a chatty CONTEXT plants.
- *Priority inflation* — "High" is defined by what is visible (hazard or
  stoppage), not by how upset the caller sounds. An out-of-enum priority falls
  back to `Medium` client-side rather than throwing.
- *Length.* `maxLength` is not preserved server-side either, so the 80-char
  subject is instruction-only; the client truncates past 120 as a backstop.

### fv-nameplate — nameplate OCR

**In**: one photo. **Out**: `{manufacturer, model, serial}`, each verbatim or
`"none"`.

**Failure modes**
- *Helpful completion.* It wants to finish a half-legible serial. A wrong serial
  is worse than no serial, so "not readable with full confidence" is `"none"`.
- *Field confusion.* MODEL/TYPE/CAT NO → `model`; SERIAL/SER NO/S/N → `serial`;
  ratings (V, A, kW, RPM, refrigerant, year) go **nowhere**.
- *Hearsay.* A technician's "the serial is probably …" in the prompt is not a
  reading — covered by `nameplate/refuses-to-guess-a-dictated-serial`.

### fv-voice — the tool-loop turn

**Deliberately schema-less.** The protocol is "one JSON tool call **or** one
plain spoken sentence", and no structured-output schema can express that union —
attaching one would force JSON on every turn and `parseTool()` in
`src/voice/toolLoop.ts` would never see a final answer. `parseTool()` returning
`null` *is* the done signal.

**In**: `CONTEXT:` (siteId / assetInView / workOrderInView), `COMMAND:`, and
after a hop a `TOOL RESULT (<tool>):` block. Six client-side tools; the agent has
no data access and no org credentials of its own.

**Failure modes**
- *Inventing an id on a write.* The dangerous one. A named asset with no id in
  CONTEXT must become `find_asset` first — enforced in instructions, again by the
  `seenAssetIds` whitelist in `toolLoop.ts`.
- *Answering in JSON, or calling a tool when it should answer.* Both turn types
  now have worked examples in the instructions.
- *Asking the user for an id it could look up.* This was the one live eval
  failure of the first tuning pass: it refused `complete_task` without a
  `taskId`, though the loop resolves a missing `taskId` itself (sole task, or an
  `Error:` listing the tasks). Instruction rule 3 + example 7 fixed it.
- *Looping.* `MAX_HOPS = 3` in the loop, "at most 3 tool calls" in the
  instructions, and an `Error:` result must produce a *corrected* call, never the
  identical one.

---

## Client-side hardening (`src/api/agents.ts`)

The platform gives no server-side retry, validation or cancellation, so all four
live here:

- **`runStructured()`** — `executeAgent` → `contentOf` → `stripFences` →
  `JSON.parse`, with **one** repair retry that re-asks with the agent's own
  broken output and the parser's complaint appended. Then a per-agent `validate`
  runs before anything is returned.
- **`AgentError`** with `kind: 'no-content' | 'parse' | 'shape' | 'timeout'` and
  the raw reply attached. Network/SDK failures are *not* wrapped — callers can
  tell "the model misbehaved" from "the network died".
- **Purity cache** — the vision agents are pure functions of their file ids, so
  `identifyAsset` (keyed on file ids + candidate ids) and `readNameplate` (keyed
  on file id) are memoised for the session, in-flight promises included, so a
  double-tap costs one inference. Failures are never cached. `draftWorkOrder` is
  **not** cached: a redraft should produce new words. `clearAgentCache()` and
  `{ noCache: true }` opt out.
- **Timeout / abort** — `AgentRunOptions { signal, timeoutMs }`, default 45 s.
  The platform run is not cancellable, so this rejects the caller's promise and
  lets the orphaned request die; the UI is never frozen by a hung agent.

Mock mode (`?mock=1`) short-circuits all four before any of this, so every agent
path stays developable with zero org access.

Exported signatures are backward compatible — the options argument is optional
and trailing on every function.

---

## The eval harness

```
node tools/agent-eval/run.mjs                 # every case, 1 sample each
node tools/agent-eval/run.mjs fv-voice        # one agent
node tools/agent-eval/run.mjs --grep final    # cases whose name matches
node tools/agent-eval/run.mjs --repeat 3      # 3 samples per case (flakiness)
node tools/agent-eval/run.mjs --json out.json # machine-readable results
```

No npm script: `package.json` is frozen for this workstream. Exit code is
non-zero if any case fails a single sample, so it drops into CI as-is. Requires
an authenticated `facilio` CLI (it shells out to `facilio vibe agent run`).

Push and verify the definitions:

```
node tools/agent-eval/push.mjs                # all four, then verify round-trip
node tools/agent-eval/push.mjs fv-voice       # one
```

`push.mjs` re-reads each agent with `agent get` and compares. Two gotchas it
handles: the platform stores `role` separately and **prepends `=== ROLE ===\n`**
to the instructions it returns, and it reorders schema object keys — so the
comparison strips that prefix and compares the schema structurally. It confirms
`fv-voice` still has **no** output schema.

Cases live in `tools/agent-eval/fixtures.mjs`. Each carries a `why`, an `input`,
an `expect(raw)` returning `true` or a failure string, and a `counterexample` —
the exact wrong reply the case exists to catch. `src/__tests__/agents-eval-helpers.test.ts`
asserts every check rejects its own counterexample, so no case can be a vacuous
pass.

Replies are scored with `tools/agent-eval/helpers.mjs`, a plain-ESM mirror of
`contentOf` / `stripFences` / `orNone` (from `src/api/agents.ts`) and
`parseTool` / `num` (from `src/voice/toolLoop.ts`) — plain ESM because the
harness must run under bare `node` with no build step. The same test file imports
**both** copies and asserts they agree case for case, so the eval scores exactly
what the app would see.

### Platform limitation: the eval is text-only

`facilio vibe agent run` has **no flag to attach `fileIds`**. No eval case can
send an image, so the three vision agents are scored only on what text can
reach: output schema and key set, the `"none"` sentinel, the no-image rule, the
confidence bound, and the id/serial fabrication traps. The image-bearing paths —
`fileIds` plumbing and the 10-file cap, cache keying, verdict mapping, the
fabrication guard — are covered offline instead by
`src/__tests__/agents-hardening.test.ts` (mocked `executeAgent`) and the
mock-mode cases in the same file.

### Results

Last run, all four live agents, **2026-08-13**:

```
total 60/60 samples (100%), 20/20 cases clean
  fv-identify   9/9  (100%)
  fv-wo-draft   9/9  (100%)
  fv-nameplate  9/9  (100%)
  fv-voice     33/33 (100%)
```

20 cases x 3 samples. Before the `complete_task` instruction fix the same suite
scored 19/20 cases (95%).

Mean latency per call: `fv-identify` 4.6 s, `fv-wo-draft` 4.3 s, `fv-nameplate`
3.8 s, `fv-voice` 3.2 s — text-only, so image runs are slower. Instructions are
1 372–3 379 characters (roughly 350–850 tokens), paid on every call: keep worked
examples earning their place.

Offline suite: `npm test` — 189 tests, of which
`agents-smoke` / `agents-hardening` / `agents-eval-helpers` are the agent seam.

---

## Changing an agent

1. Edit `agents/<name>.txt` and/or `<name>.schema.json`. Schema rules: `title` is
   **mandatory** and must match `[A-Za-z0-9_-]{1,64}`; unions are unsupported (use
   a `"none"` string sentinel); numeric `minimum`/`maximum` and string
   `maxLength` are **not preserved server-side**, so restate every bound in the
   instructions *and* enforce it in `src/api/agents.ts`; keep
   `additionalProperties: false` and a `description` on every field.
2. `node tools/agent-eval/push.mjs <name>` — pushes and verifies the round-trip.
3. `node tools/agent-eval/run.mjs <name> --repeat 3`.
4. If you changed a contract, update the validator in `src/api/agents.ts` and add
   a case (with a counterexample) to `fixtures.mjs`.
5. `npm run typecheck && npm test && npm run build`.
