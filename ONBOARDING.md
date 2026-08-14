# Facilio Vision 3D — team setup

One repo, one deployed app, three people pushing. This is everything you need
from a clean machine to a shipped release.

|  |  |
|---|---|
| Repo | https://github.com/stevegk7/FacilioVibe |
| App (preview) | https://preview-facilio-vision-3d.vibe.facilio.com/ |
| App (production) | https://facilio-vision-3d.vibe.facilio.com/ — **live**, promoted 2026-08-14 |
| App link name | `facilio-vision-3d` (in `vibe.json`) |
| Org | Facilio Vetri Kazhagam (**#2915**), region US |
| Stack | React 18 + Vite + TypeScript + `@facilio/vibe-sdk` 0.3.x, three.js 0.128.0 pinned |

The app is the merge of two: the **field half** (AR camera, markers, surveys,
wayfinding, voice) and the **desk half** (a three.js estate model). Both halves
read the same live CMMS data.

---

## 1. Machine setup (once)

```bash
node -v                          # 22.12+ — see below, 20 is NOT enough
npm install -g @facilio/cli      # the binary is `facilio`
facilio login                    # opens a browser — approve once
facilio whoami
```

Node 22.12 or newer, not 20: `jsdom` and `oxlint` both refuse to run below
20.19/22.12, and the seeding tools in §9 need `--experimental-strip-types`,
which only exists from 22.6.

**Stop and read the `whoami` output.** It must say:

```
Organization: Facilio Vetri Kazhagam (#2915)
```

If it names any other org you are signed in with a personal account. You do not
have to throw that session away — the CLI keeps profiles:

```bash
facilio accounts            # list your logins
facilio switch <profile>    # change the active one
facilio whoami --profile x  # or target one command
```

The CLI takes the org from the **session**, not a flag — there is no `--org` —
so run `facilio whoami` before every deploy or seed. A deploy from the wrong
session ships our app into someone else's org.

You also need `gh` authenticated (`gh auth status`) and **write access to the
repo**. It is stevegk7's repo; if `git push` returns 403, ask him to add you as
a collaborator. Read access is not enough.

## 2. Get the code

```bash
git clone https://github.com/stevegk7/FacilioVibe.git
cd FacilioVibe
npm install
npm run dev          # http://localhost:5173/?mock=1
```

**Always open localhost with `?mock=1`.** Auth is cookie-based on the
`*.vibe.facilio.com` origin, so a local dev server cannot load live data at
all. Mock mode renders the entire app — 3D estate, AR, wayfinder, surveys —
from fixtures, and seeds its own demo wayfinding data on first visit. You can
build almost anything without touching the org.

## 3. The daily loop

`main` is the release branch. Nothing is pushed to it directly.

```bash
git switch main && git pull          # ALWAYS pull first — three people push here
git switch -c <yourname>/<topic>     # e.g. priya/asset-lookup

# ...work...

npm run verify                       # must pass before you open the PR
git add -A && git commit -m "..."
git push -u origin <yourname>/<topic>
gh pr create --fill
```

Get one teammate to review, then merge.

**Rebase before you open the PR if your branch is more than a few hours old.**
A branch cut before someone else's merge will show *their* commits as deletions
in the diff, and merging that silently reverts their work. Check with:

```bash
git log <yourbranch>..origin/main    # empty = you are current
git rebase origin/main               # if not
```

This has already bitten us once. It is the single easiest way to lose a
teammate's day.

## 4. `npm run verify` — the gate

```
npm run build         tsc --noEmit + vite build
npm run test          vitest (50 files, 445 tests)
npm run check         offline geometry/record check over real org fixtures
npm run check:3d      the three.js CAD path, offline
npm run check:bundle  fails if three.js lands in the entry chunk or it exceeds
                      160 KB gzip — this is what keeps the 3D engine off the
                      technician's AR path
```

```
npm run typecheck     tsc --noEmit only — the fast inner loop, seconds not minutes
```

All five gate steps must pass. Two things about them: `check:bundle` reads
`dist/`, so it only works after a build (which is why `verify` chains build
first), and the entry chunk is currently ~155 KB against the 160 KB budget —
about 5% of headroom, so one ordinary new dependency imported from a screen
will fail it. The fix is a dynamic import, the way `src/estate/loadEngine.ts`
does it; the script prints the lazy-chunk list so you can confirm it moved.

`npm run lint` (oxlint) is advisory, not in the gate, and currently noisy —
including in the vendored `public/*.js`. Worry only about new warnings in files
you touched.

**Never edit a check to make it pass.** The three.js pin assertion and the
bundle guard exist to stop exactly that.

## 5. Releasing

**There is no CI.** The repo has no `.github/workflows` — despite what older
docs claimed, merging does not deploy anything. A release is a human running:

```bash
git switch main && git pull
npm run verify
npm run deploy        # = npm run build && facilio vibe deploy
```

`facilio vibe deploy` publishes to the **preview** URL, always. `--prod` records
intent but does not promote. Production cutover is a person clicking *Publish to
production* in Vibe Studio.

**Production is live** (promoted 2026-08-14 12:45). Check with
`facilio vibe app list` — a date in the PUBLISHED column means the production
URL is serving a real build; an em-dash means it never has. Treat every promote
as a public change now, and re-read §5's shared-database warning before any
seed or KV write.

After promoting, confirm the KV function came with it:

```bash
facilio vibe function run fvApi health
```

The function is promoted **per channel**; a build promoted without it answers
404 on every KV call, at which point reads degrade to empty and writes throw.

> **Preview and production share ONE database.** From the first preview write,
> you are writing production data. There is no sandbox.

## 6. Reading and writing Facilio data

`vibe.executeAction(connectionSlug, actionSlug, payload)` is the only supported
route to CMMS data, and only `src/api/*` may call it — screens import the
`provider` seam instead, which is what makes `?mock=1` work everywhere.

**Never guess a slug or a payload shape.** Discover them from the CLI first:

```bash
facilio connections search "work orders"
facilio connections schemas facilio-cmms.list-work-orders --with-output
facilio connections execute facilio-cmms.list-work-orders --params '{"page_size":5}'
```

Note `--params`, not `--payload`. Wire it into the app only after the CLI call
returns what you expect.

Verified quirks of this org's API, all learned the hard way:

- **`facilio-cmms.create-work-order` is unusable.** Its schema demands `siteId`
  as an object; the backend demands a Long. No payload satisfies both. Creates
  go through the script lane instead — `src/api/scriptFns.ts`.
- Filters use `field(is)=a,b` for IN. A bare `id=a,b` returns an HTML error page.
- A field that does not exist in `select`/`expand` fails loudly:
  `success:false`, `code: INVALID_FIELD`, naming the field. But a field that
  exists and is simply not projectable — `siteId` on `workorder` — is **dropped
  from the rows with no error at all**. Read those through `expand`.
- `siteId` works fine as a *filter* on `workorder`; it just never comes back in
  a `select`.
- `sort_by: "id"` is rejected: "Field 'id' is not sortable."
- Failures are reported in-band at HTTP 200. Check `success`, not the status.

## 7. The app's own storage (`fvApi`)

Surveys, QR codes and settings live in three all-text Postgres tables behind a
Studio function. The app calls it through `src/api/appStore.ts`; you can call it
directly:

```bash
facilio vibe function run fvApi health
facilio vibe function run fvApi kvList --args '{"collection":"settings","prefix":"wf.graph."}'
facilio vibe function run fvApi kvGet  --args '{"collection":"surveys","key":"survey.demo-plant"}'
```

Handlers: `health`, `kvPut`, `kvGet`, `kvList`, `kvDelete`. Collections:
`surveys`, `codes`, `settings` — anything else is rejected.

The DB role has **no DDL**. Tables exist only via `facilio vibe db import`, all
columns are text, there are no constraints and therefore no `ON CONFLICT` —
`kvPut` is update-then-insert. In `?mock=1` the same API writes to
`localStorage` instead, and Settings → Danger zone clears it.

## 8. The AI agents

Six prompt-configured agents on `openai/gpt-5.5`. The instructions in
`agents/*.txt` are the source of truth — **never edit an agent in the UI**, it
will be overwritten.

| agent | does |
|---|---|
| `fv-identify` | confirms which asset a camera snap shows |
| `fv-wo-draft` | drafts a work order from a fault photo |
| `fv-nameplate` | reads a nameplate photo |
| `fv-tasks` | suggests checklist tasks |
| `fv-voice` | Effi — orchestrates a client-side tool loop |
| `fv-wayfinder` | resolves a spoken destination to one standpoint |

```bash
node tools/agent-eval/push.mjs fv-wayfinder   # deploy one agent
node tools/agent-eval/run.mjs fv-wayfinder    # score it against fixtures
facilio vibe agent list
```

Agents are platform records, **not part of the app bundle** — a push goes live
immediately on both channels, without a deploy.

Three rules that are not optional:

1. **The agent decides; the app acts.** No agent gets server-side tools or org
   credentials — they invent record ids. Every write and every navigation is
   whitelisted client-side against ids the app itself surfaced.
2. **The reply is a JSON *string*** at `res.response.content`. Parse it after
   stripping code fences. This is the most common agent bug.
3. **Schemas silently drop `maxLength`, `minimum` and `maximum`.** Restate every
   bound in the instructions *and* enforce it client-side, or `push.mjs` fails
   its round-trip check.

## 9. Demo data

```bash
node --experimental-strip-types tools/seed-wayfinding.mjs --check   # dry run
node --experimental-strip-types tools/seed-wayfinding.mjs           # seed live
node --experimental-strip-types tools/seed-wayfinding.mjs --sweep   # remove it
```

Seeds four standpoints with QR codes, a Tower A route graph, and site
coordinates on org #2915. It refuses to run unless `whoami` says #2915, merges
rather than overwrites the route graph (so hand-drawn edges survive), and never
overwrites admin-set site coordinates. `?mock=1` seeds its own equivalent
automatically.

## 10. Where things live

```
src/api/          the provider seam — the ONLY place that touches the SDK
src/screens/      one file per tab
src/layout/       AppShell — the chrome that consumes the screen registry
src/shell/        goToTab router, ErrorBoundary, embed detection
src/components/   Sheet, DsSelect, AssetSelect, Icon, camera
src/state/        LocationContext (site/building/floor scope)
src/hooks/        useHeading (pose), useGeoFix
src/ar/           AR projection, markers, pose fusion
src/vision/       camera scan loop, QR, embeddings
src/wayfinding/   TWO graphs: the hand-authored one (graph.ts — survey
                  standpoints + human-drawn edges) and the auto-graph derived
                  from the estate hierarchy (autoGraph.ts). Plus router,
                  journey model, demo dataset.
src/rounds/       inspection rounds: store, active-round chip, CSV export
src/estate/       the 3D estate (lazy-loaded — see below)
src/voice/        Effi: intents + the client-side tool loop
src/__tests__/    screen and integration tests (pure modules test in place)
agents/           agent instructions + schemas (source of truth)
functions/fvApi/  the KV function
fixtures/         real org #2915 snapshots — back ?mock=1, npm run check, ?harness=1
public/           VENDORED three.js engine + taxonomy globals (patched, never
                  regenerate — docs/ESTATE-3D.md) and the extracted CAD plans
tools/            agent push/eval, wayfinding seeder, CAD plan extractor
docs/             AGENTS.md, AI-FLOW.md, ESTATE-3D.md, WAYFINDING.md, ROADMAP.md
```

**Read `docs/` before changing the thing it describes.** `WAYFINDING.md` in
particular records the research the wayfinder UX is built on — changing that
screen without reading it means re-litigating decisions that already have
evidence behind them.

## 11. Known snags

- **three.js is pinned to exactly 0.128.0.** r152 turned colour management on by
  default and r155 went physically-correct; either re-grades the whole scene.
  `npm run check:3d` fails if the pin moves.
- **The 3D runtime is not in `index.html`.** It is injected on first 3D use
  (`src/estate/loadEngine.ts`) so the technician who only opens the camera never
  pays for it. Load order there is load-bearing and fails silently if broken.
- **`facilio vibe app create` needs a real terminal** — its prompts abort on
  piped stdin. (Already done for this app.)
- **`@facilio/vibe-sdk` is 0.3.x, not 1.x.** Don't "fix" the version range.
- **Pushing `.github/workflows/` needs the `workflow` OAuth scope**:
  `gh auth refresh -h github.com -s workflow`.
- **Camera needs HTTPS or localhost.** It will not start on a LAN IP.

---

## 12. Making your first change

**Finding a screen.** The dock holds three tabs (3D Estate · AR · Wayfinder) —
that is a design rule, not an oversight. Every other screen is `visible: false`
and reached through the dock's **More** sheet, the desktop sidebar, or
`?tab=<id>`: `surveys`, `rounds`, `settings`, `diagnostics`, `portfolio`,
`dashboard`, `capture`, `rooms`, `voice`. (`?tab=boom` crashes on purpose — it
is the error-boundary test.) The landing tab is `estate` on ≥1024px, `ar` below.

**Adding a screen.** Create `src/screens/YourScreen.tsx`, then register it in
the `SCREENS` array in `src/App.tsx`; the field contract is documented on
`ShellScreen` in `src/layout/AppShell.tsx`. `visible: false` is the normal
choice. Icons come from `src/layout/icons.tsx`. Note that
`src/shell/TabShell.tsx` is a dead pre-merge copy of the registry — editing it
does nothing.

**URL params that must survive navigation:** `mock`, `capp_id`, `origin`,
`login`, `harness`. Navigate with `goToTab()` from `src/shell/router.ts`, never
`history.pushState` directly — that changes the URL without changing the screen
and drops mock/embed context.

**Writing a test.** Two conventions coexist, both run by `npm run test`:
screen- and integration-level tests live flat in `src/__tests__/*.test.ts(x)`;
pure modules increasingly keep their tests beside them (`src/wayfinding/
autoGraph.test.ts`). Put a test next to the module when it needs no DOM.
jsdom + Testing Library either way. Vitest globals are **off** — import `{ describe, it, expect }`
from `vitest` explicitly. `setup.ts` already clears the DOM, storage and history
between tests. Three ways to fake data:

- `window.history.replaceState({}, '', '/?mock=1')` — the whole fixture provider
- `fakeDeps()` from `wsC-fakes.ts` — anything voice-shaped
- import `mockProvider` directly — pure data assertions

**Never monkey-patch `provider`** — it is a Proxy resolved per property access,
and patching it is a documented trap.

**Extending the provider seam** is four edits in lockstep: the `DataProvider`
interface, `mockProvider`, `realProvider`, and usually `types.ts`. Implement
only the real half and `?mock=1` throws for everyone. `provider-seam.test.ts`
fails the build if the SDK is imported outside `src/api/`. Agents have the same
rule: every wrapper in `src/api/agents.ts` needs an `isMockMode()` branch.

**UI rules.** Colours, spacing and radii come from `src/styles/tokens.css` —
never raw hex. Never a native browser control: use `DsSelect`, `Sheet`,
`AssetSelect`, `LocationPicker` from `src/components/`, or build one in that
style. Touch targets ≥44px, inputs ≥16px or iOS zooms the page, and the page
itself never scrolls — panes scroll internally via `.scroll-y`.

## 13. When something does not work

**Open `?tab=diagnostics` first.** It prints provider mode, session, org,
embed/`capp_id`, and round-trips the KV store.

| symptom | first thing to check |
|---|---|
| camera says "unavailable" | denied permission, non-HTTPS origin, or a webview without `allowsInlineMediaPlayback`. Every scan sheet has a type-the-code lane — use it to keep moving. |
| a scanned code resolves to "unknown" | it is not in the registry; link it from the code sheet. A **conflict** must be resolved by a human, never auto-repointed. |
| a write "succeeded" but the org has nothing | real-provider writes ride `src/api/offlineQueue.ts` — network-shaped failures park in `localStorage` (`fv.offlineQueue`) and replay on reconnect. |
| app counts < raw API counts | correct. `src/api/recordPolicy.js` hides this org's 16 `OBSOLETE` test artifacts, in both providers. |
| "No vibe.json found" | you are in the wrong directory. Every `facilio vibe` command resolves the app from `vibe.json` in the CWD. **Do not** run `facilio vibe app create` — it would make a duplicate app. |

## 14. Which commands touch real data

Preview and production share one database, and the CLI has no mock lane.

**Safe (read-only):** `connections search` · `connections schemas` ·
`connections execute` on a `list-*` action · `fvApi health` / `kvGet` / `kvList`
· `vibe app list` · `vibe agent list` / `get` · `seed-wayfinding.mjs --check`

**Writes real data:** `connections execute` on any create/update ·
`fvApi kvPut` / `kvDelete` · `seed-wayfinding.mjs` with no flag ·
`agent-eval/push.mjs` (changes a live agent) · `agent-eval/run.mjs` (live,
billable calls — and it has no `--help`, so a stray flag runs the whole suite)
· `npm run deploy`

Rehearse writes with `facilio connections execute --dry-run` first.

## 15. Shipping a change to `fvApi` or an agent

Both are **separate deploy lanes** — `npm run deploy` only ships `dist/`.

```bash
# the KV function
facilio vibe function update fvApi --code functions/fvApi/code.ts
facilio vibe function build fvApi
facilio vibe function run fvApi health

# an agent (goes live immediately, on both channels)
node tools/agent-eval/push.mjs fv-wayfinder
node tools/agent-eval/run.mjs fv-wayfinder
```

Adding a *new* agent is six edits: `agents/<name>.txt`, usually
`agents/<name>.schema.json`, an entry in `AGENT_FILES` in `push.mjs` (without it
the tool cannot see your agent), cases in `fixtures.mjs`, a name constant +
wrapper + `mock.*` branch in `src/api/agents.ts`, and a row in `docs/AGENTS.md`.

`facilio vibe agent run` is **text-only** — it cannot attach images, so the
photo agents can never be evaluated end to end from the CLI. Their image paths
are covered by `src/__tests__/agents-hardening.test.ts` instead.

## 16. The PR itself

There is no PR template, no CODEOWNERS, no required review and no CI status to
wait for — `main` is a convention, not a protected branch. So the discipline is
social: get a teammate to look, then merge your own PR.

A good PR body here says what changed and why, which `verify` steps you ran,
screenshots for anything visual, and **any live-data writes you made** (seeds,
KV writes, agent pushes, work orders created) — because those are not in the
diff and nobody can see them from the code.
