# Wayfinding — why the screen works the way it does

The Wayfinder was rebuilt (2026-08-14) on a research pass over shipped indoor
wayfinding products (MazeMap, Mappedin, Pointr, Situm, Living Map, Google/Apple
indoor) and the academic work on pedestrian route guidance. This file records
the findings the design is anchored to, so a future change knows what it is
trading away.

## The findings, and where they landed

**Route preview beats forced turn-by-turn for people who know the building.**
A field study (PLOS, n=422) found preview + step list equal to guided mode on
errors and preferred by 76% of users in familiar environments — and a
technician is exactly that user. → Preview is the default; **Guide me** is
opt-in (`WayfinderScreen` journey phases `preview → guided → arrived`).

**Landmark-phrased instructions beat distances.** Multiple studies: fewer
wrong turns, higher confidence. Distances are secondary metadata, not the
sentence. → The graph editor surfaces the edge `instruction` field
("Past the red fire-hose cabinet, then left"); `stepText` already preferred
it; the demo dataset ships landmark phrasing on every walk edge.

**Discrete positioning is a first-class product tier, not a compromise.**
Situm ships an app-free web mode with manual start + destination and no live
dot; kiosk wayfinding hands routes to phones via QR. Faking a blue dot from
guesses destroys trust. → Position is an **anchor**: `{node, via scan|gps|pick,
at}` with visible staleness ("scanned 4 min ago"), never a dot.

**Steps never self-advance.** With discrete positioning you cannot know the
user moved; wrongly advanced steps are worse than manual taps. → **I'm here**
advances; a QR scan is hard verification that re-anchors and recomputes
quietly ("Route updated from <node>") — off-route is a re-anchor, never an
alarm.

**Floor changes are the highest-error moment indoors.** They get interstitial
step cards (big badge, lift/stairs icon, target level), not ordinary rows.

**Arrival is a state, not the last row.** A distinct arrived card closes the
loop and hands the last leg to the AR arrow — marker bearings are rays with no
range, so the route ends at the destination standpoint by design.

**Assistants in this space are grounded resolvers, not narrators.** Pointr's
AI agents, Mapbox MapGPT and the LLM-wayfinding literature all converge:
natural language → entity from a closed set → disambiguation → the terminal
act is LAUNCHING the route. → The assist row resolves plain names with a
deterministic search (chips on ambiguity) and hands harder language to the
fv-voice tool loop with deps overridden so `navigate_to`/`show_on_site` SET
this screen's route instead of describing one or yanking tabs.

## Demo dataset

One builder, two id universes (`src/wayfinding/demoData.ts`):

- **Mock** (`?mock=1`): auto-seeded into localStorage KV on first Wayfinder
  visit (`src/api/seedDemoData.ts`); cleared by Settings → Danger zone.
- **Live** (org #2915): `node --experimental-strip-types
  tools/seed-wayfinding.mjs` (guards on `whoami` = #2915; `--check` dry-runs,
  `--sweep` removes every demo key; graph writes MERGE with hand-authored
  content, never overwrite).

The journey: Main Entrance → Lobby → Lift A → Mechanical Floor landing →
Plant Room (chiller/AHU/pump markers), with a Server Room detour and a
Stairwell B alternative. Every standpoint has a `fv-sv-demo-*` QR code — print
them from the Surveys screen to walk the demo physically.

## Seams a future change must respect

- `?asset=` handoffs are consumed **while mounted** (router `onNavigate`), then
  cleared with `setNavParams({asset: null})` — a stale param must not re-fire.
  Both WayfinderScreen and ARScreen do this now.
- A Wayfinder scan calls `stampStopByCode` — position proof doubles as round
  proof, same as the AR scan lane.
- `src/wayfinding/resolve.ts` is the one definition of "which standpoint
  routes to this asset/place" — the screen and the voice deps both use it.
