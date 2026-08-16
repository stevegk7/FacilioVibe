# Wayfinding — technical reference

Companion to [`WAYFINDING.md`](./WAYFINDING.md), which records *why* the
product behaves as it does. This file records *how it is built*: the data
models, the algorithms, the storage contracts, and the seams a change must not
break.

Scope: `src/wayfinding/**` (23 modules, 88 tests across 8 files),
`src/screens/WayfinderScreen.tsx`, and the two contracts it shares with the 3D
estate screen.

Everything below is stated against the code as it is today. Where a number is
quoted it is a constant in the source, not a target.

---

## 1. Two graphs, on purpose

The single most important thing to understand: **there are two independent
routing systems**, with separate data models, separate storage, and separate
routers. They are not layers of one thing, and neither is deprecated.

| | Survey graph | Portfolio auto-graph |
|---|---|---|
| Module | `graph.ts` + `router.ts` | `autoGraph.ts` |
| Nodes | Hand-authored + survey standpoints | Derived from the estate hierarchy |
| Authored by | A human, in the graph editor | Nobody — rebuilt from data |
| Persisted | `settings/wf.graph.<siteId>` | Not persisted; only its overlay is |
| Scale | Tens of nodes | Thousands (21k measured) |
| Router | `findRoute` — linear-scan Dijkstra | `routeOnGraph` — binary-heap Dijkstra |
| Precision | Metre-level, landmark-phrased | Room-level, derived |
| Ends at | A standpoint, handing off to AR | A space or asset node |
| Positioning | QR scan / GPS / manual pick | Inherited, or the 3D selection |

**Why both exist.** The survey graph is precise where somebody has walked the
building and authored it: real corridors, real landmarks, a route that ends at
a standpoint whose QR proves you arrived. The auto-graph covers *everything
else* — every site, building, floor, space and asset in the portfolio, with no
authoring at all — at the cost of only knowing what containment and floor-plan
geometry can tell it.

A destination that exists in both goes to the survey lane. `WayfinderScreen`
decides this in `applyResolvedNode`: an asset pinned at a standpoint routes on
the survey graph; everything else routes on the auto-graph.

---

## 2. Survey graph (`graph.ts`, `router.ts`)

### 2.1 Data model

```ts
type NodeKind = 'standpoint' | 'entrance' | 'lift' | 'stairs' | 'junction';
type EdgeKind = 'walk' | 'lift' | 'stairs' | 'door';

interface WayNode {
  id: string;
  kind: NodeKind;
  name: string;
  buildingId?: number;
  floorId?: number;
  floorLevel?: number;   // Facilio floor.floorlevel — drives "take the lift to L9"
  surveyId?: string;     // set when this node IS a survey standpoint
  code?: string;         // QR value that puts you here when scanned
  lat?: number; lng?: number;
}

interface WayEdge {
  id: string; from: string; to: string;
  kind: EdgeKind;
  meters?: number;       // omitted → the kind's default cost
  instruction?: string;  // authored landmark, overrides generated phrasing
  oneWay?: boolean;      // edges are two-way unless set
}

interface WayGraph { siteId: number; nodes: WayNode[]; edges: WayEdge[]; updatedAt: string; }
```

### 2.2 Storage

One document per site: `settings/wf.graph.<siteId>` via `appStore` (the `fvApi`
KV). `loadGraph` / `saveGraph` are the only accessors.

`withSurveyNodes(graph, surveys)` merges standpoints in **at read time** —
survey nodes are never persisted into the authored document. A standpoint is a
survey fact; duplicating it into the graph would create two sources of truth
that drift.

### 2.3 Cost model

Default costs when an edge carries no `meters` (`router.ts`):

| kind | default cost |
|---|---|
| `walk` | 25 |
| `door` | 5 |
| `stairs` | 60 |
| `lift` | 90 |

Lifts cost more than stairs deliberately: a lift is mostly waiting. When both
endpoints are geotagged and `meters` is absent, the real haversine distance is
used instead (`edgeMeters`).

> ⚠️ **A null-metre edge silently wins.** An edge with `meters` unset costs the
> kind default (25), which can beat an authored 30 m path. Six such edges were
> found on the live graph and were making every entrance→lift route skip
> reception and its two authored landmarks. If routes look "too direct", check
> for uncosted edges first.

### 2.4 `findRoute` — linear-scan Dijkstra

`findRoute(graph, fromId, toId): Route | null`

Deliberately a linear scan, not a heap: this graph is tens of nodes, and the
scan is clearer. **Do not "optimise" it to match the auto-graph router** — the
comment in the source says so, and the scale that justified a heap does not
exist here.

Returns `null` when there is no path — never a partial route. Half a route
walked confidently is worse than being told the building is not mapped.

Each `RouteStep` carries `from`, `to`, `edge`, `meters`, a ready-to-act `text`
line, and `bearing` **only when both ends are geotagged**. The facing indicator
does not appear for indoor edges rather than inventing a heading.

### 2.5 GPS anchoring

```
GPS_ANCHOR_MAX_ACCURACY_M = 50            // beyond this the fix names a suburb
gpsAnchorRadiusM(acc)      = max(150, 3 × acc)
anchorFromFix(graph, fix)  → WayNode | null   // entrances ONLY
```

Two independent gates, doing different jobs: the **accuracy** gate rejects a
junk fix; the **radius** gate rejects the wrong place. The radius is
building-scale on purpose — an entrance coordinate is one point standing in for
a whole façade, and the shipped demo's own entrance sits ~119 m from the mock
fixture while still being a genuine "at this entrance".

`anchorFromFix` matches **entrances only**. An earlier untyped fallback would
anchor you to a plant room on Level 9 because it happened to be the closest
geotagged node. Returning `null` is a real answer: the caller leaves *From*
unset and says why.

---

## 3. Portfolio auto-graph (`autoGraph.ts`)

### 3.1 Data model

```ts
type AutoNodeKind = 'site' | 'building' | 'floor' | 'space' | 'asset' | 'core';
type AutoEdgeKind = 'walk' | 'door' | 'stairs' | 'outdoor';
```

Node ids are `kind:recordId` — `site:1001`, `building:201`, `floor:301`,
`space:401`, `asset:9001`, plus one synthetic `core:<buildingId>` per
multi-floor building. **Ids are stable and disjoint from the survey graph's**
(`sv:` and hand-authored ids), so the two can never collide.

**Two coordinate frames, never mixed inside one leg:**

- floor-scoped nodes (`space`, `asset`, `floor`) carry **floor-local metres**,
  the same frame as `EstateSpace.polygon`;
- `building` and `site` nodes carry **world metres**;
- `geo` (lat/lng) exists **only** on site nodes, and only when supplied.

### 3.2 Derivation

`buildAutoGraph(estate: EstateData, opts): AutoGraph` — pure. No SDK imports,
no store, no engine; enforced by the provider-seam test.

Edges produced:

| Edge | Weight | Notes |
|---|---|---|
| asset ↔ owning space | node distance | falls back to the floor circulation node when `spaceId` is null (corridor plant) |
| space ↔ floor circulation | node distance | circulation point is the mean of the floor's room centres — provably inside the rooms' bbox |
| space ↔ space (`door`) | node distance | **only** where plan rectangles genuinely face each other |
| floor ↔ `core:<building>` (`stairs`) | ranking only | re-measured on output as `4 m × |Δlevel|` |
| building ↔ site (`outdoor`) | world distance, min 5 m | |
| site ↔ site (`outdoor`) | haversine, or `Infinity` + `unroutable` | |

**Doorway derivation is the subtle part.** `rectsShareWall(A, B)` treats two
rooms as connected when some rectangle of A faces some rectangle of B across at
most `WALL_TOL_M = 0.6` m with an overlap of at least `DOORWAY_MIN_M = 0.9` m.
0.6 m is not arbitrary — it matches the plan extractor's door-seal radius, the
distance its flood fill jumps to merge rooms through an opening. The seal is
never recorded in the plan JSON, so this recovers the same adjacency from the
rectangles.

**Schematic floors get no doorways at all.** A floor without a measured plan
has no rectangles to compare, so its spaces connect hub-and-spoke through the
circulation node only. This is correct: inventing doorways on a schematic would
draw corridors that do not exist.

### 3.3 `routeOnGraph` — heap Dijkstra

`routeOnGraph(graph, fromId, toId): AutoRoute`

```ts
type AutoRoute =
  | { unroutable?: false; legs: AutoLeg[]; distanceM: number }
  | { unroutable: true; reason: string };
```

Implementation notes that matter:

- **Binary min-heap with lazy deletion** — no decrease-key; duplicates are
  pushed and stale pops skipped.
- **Per-graph caches** (`nodeIndex`, adjacency) in a `WeakMap` keyed by the
  graph object. Because `buildAutoGraph` returns a fresh object every time, a
  cached index can never go stale behind a caller's back.
- Measured: **21k nodes, 5,104 ms → 143 ms**. Guarded by
  `router-scale.test.ts` at a 2.5 s bound (the old scan measured 3,979 ms, so
  the gate is decisive rather than cosmetic).

**Unroutable answers name the fix.** When no path exists, the router re-runs
allowing uncosted hops to distinguish two cases:

- *"the connecting site-to-site hop needs geo (lat/lng) on both sites"* — the
  user can fix this;
- *"the graph has no connecting edges"* — they cannot.

This is why `unroutable` edges stay **in** the graph rather than being dropped:
a dropped edge leaves a silent island with no explanation.

### 3.4 Leg grouping

Hops are grouped into legs by movement kind, and indoor runs are **further split
per floor** so a leg's points stay in one coordinate frame. Vertical legs are
re-measured from real floor levels (`4 m × |Δlevel|`) because the core hub's
edge weights exist only for ranking.

---

## 4. The overlay (`autoGraphStore.ts`)

The derived graph is never persisted. What *is* persisted is the human/agent
refinement on top of it:

```ts
interface AutoGraphOverlay {
  addEdges: AutoEdge[];
  removeEdgeIds: string[];
  edgeNotes: Record<string, EdgeNote>;  // landmark text per derived edge id
  version: number;
}
```

Stored at `settings/wf.autograph.<siteId>`. `applyOverlay(graph, overlay)` is
pure: removals first, then **validated** additions — an added edge whose
endpoints are not both present is dropped, not trusted, and `validateOverlay`
reports how many were dropped so a UI can say so.

This survives rebuilds by construction: the base graph is re-derived from live
data every time, and the overlay is re-applied to whatever it produces.

### Concurrency

`saveEdgeNote(..., expectedVersion)` throws `OverlayConflictError` when the
stored version has moved. This is **conflict detection, not a transaction** —
the KV store has no compare-and-swap, so a genuinely simultaneous pair of
writes can still interleave. What it reliably catches is the real case: two
people editing minutes apart.

That matters more than it sounds, because **preview and production share one
database** — "two authors" includes a developer exercising the editor against
preview while a technician is in the field.

---

## 5. Positioning: the anchor model (`journey.ts`)

There is no continuous indoor position, and the app never fakes one.

```ts
interface Anchor {
  nodeId: string;
  via: 'scan' | 'gps' | 'pick';   // how honestly we know it
  at: number;                      // epoch ms; scans age visibly
}
ANCHOR_FRESH_MS = 5 * 60_000
```

Trust order, as implemented in `WayfinderScreen.currentAutoNode`:

1. **A QR scan** — proof. Also stamps round presence (`stampStopByCode`).
2. **The 3D estate's live selection** — read from `fv.navContext`, gated at 15
   minutes.
3. **The location scope** — floor, then building, then site.

`anchorAgeText` renders provenance in the UI ("scanned 4 min ago", "nearest
entrance by GPS", "set by hand"). `anchorIsStale` marks scans older than the
freshness window. **Steps never self-advance** — with discrete positioning you
cannot know the user moved.

---

## 6. Conversational resolution (`conversation.ts`)

`resolvePortfolio(graph, text): Resolution` — deterministic, side-effect free,
and structurally incapable of inventing a place: it can only return nodes that
exist in the graph.

```ts
type Resolution =
  | { kind: 'one'; node: AutoNode }
  | { kind: 'many'; candidates: AutoNode[]; question: string }
  | { kind: 'none' };
```

`parseFloorRef` extracts a floor reference before matching — `"9th floor"`,
`"floor 9"`, `"level 9"`, `"L9"`, `"ninth floor"`, `"ground floor"` — then
strips conversational shell words (`take me to`, `where is`, `show me`, …) so
the remainder is a clean name query. A named floor that the numeric parser
cannot hold (`"plant room on the mechanical floor"`) is retried by splitting on
` on ` and filtering candidates by the floor's label.

Twins are disambiguated by location, not by guessing: two assets called "AHU"
on different floors produce `kind: 'many'` with `nodeWhere()` labels
(`"Tower A · Floor 9"`) so the chips are tellable apart.

**Lane order in `WayfinderScreen.runAssist`** — cheapest first, and only what
the previous lane cannot hold falls through:

0. `resolvePortfolio` — the graph. Instant, offline, no model.
1. `provider.searchAssets` — plain name search over the org's assets.
2. `resolveDestination` (`fv-wayfinder`) — language against the **closed set**
   of pinned destinations. The agent answers with a *list position*, never an
   id, so a fabricated destination is arithmetically impossible; positions
   outside the offered range are dropped rather than clamped.
3. `runToolLoop` (`fv-voice`) — for questions that are not destinations at all.

`fallbackGuidance(graph, dest)` composes step text from the real hierarchy when
no route can be drawn, and **says so first** ("I couldn't draw an automatic
route to X"). Never an empty map, never a guess dressed as a route.

---

## 7. Cross-screen contracts

Two `sessionStorage` keys are the entire interface between the Wayfinder and
the 3D estate. Both are merge-tolerant and version-tolerant by design.

### `fv.pendingRoute` — Wayfinder → estate

Written by `showRouteIn3d`, consumed **once** by `EstateScreen` inside
`acquire().then(...)` and immediately removed.

```ts
interface PendingRoutePayload {
  legs: RouteDrawLeg[];
  dest?: { kind: 'asset' | 'space'; recordId: number };
}
```

The consumer accepts **both** the current object shape and the original bare
legs array — a stale tab can hand over the old one. On arrival it calls
`engine.showRoute(legs)`, then flies: `flyToMarker` for an asset, `select(…,
'space')` for a space (which recovers cross-floor), else the first indoor leg's
floor. A destination with no drawable route still gets highlighted.

Timing is load-bearing: the payload is consumed *after* the engine mounts. A
route drawn before the floor exists is a ribbon in the void.

### `fv.navContext` — estate → Wayfinder

Merge-written by `writeNavContext` on every level change and selection, so a
selection cannot erase the level or vice versa. Carries stable ids only
(`buildingId`, `floorId`, `assetId`, `spaceId`) plus `at` for the staleness
gate.

### `legsToRouteSpec` (`routeDraw.ts`)

Pure translation from router legs to engine draw specs. **Vertical legs are
dropped** — stairs draw nothing; the step strip narrates them. Degenerate legs
(<2 points) are dropped. It never throws; malformed legs are skipped.

### Engine side (`public/estate-engine.js`)

```ts
showRoute(specs: EngineRouteLeg[]): void;
clearRoute(): void;
```

Indoor legs become tube meshes added to **the owning floor's group**, so peel,
visibility and opacity inherit for free. Outdoor legs are dashed lines at the
scene root in world metres. `clearRoute` disposes geometry and material, and is
called from `api.reset`.

---

## 8. Supporting modules

| Module | Responsibility |
|---|---|
| `resolve.ts` | The **one** definition of "which standpoint routes to this asset/place". Both the screen and the voice deps use it. |
| `legs.ts` | Outdoor leg text; `mapsDirectionsUrl` deep link. |
| `geo.ts` | `haversineMeters`, `initialBearingDeg`, `shortlist` for nearest-N by fix. |
| `coverage.ts` | `siteCoverage` / `unroutableAssets` — what the graph can and cannot reach, and why. Drives the readiness UI. |
| `plate.ts` | Floor-plate geometry → SVG paths for the 2D mini-map. |
| `facing.ts` | Heading cone maths. `CONE_MIN_DEG 15` / `MAX 60` / `UNKNOWN 35`; `turnPhrase` for relative bearings. |
| `bearing.ts` | Compass words and caption phrasing. |
| `demoData.ts` | One builder, two id universes (mock KV and live org #2915). |

---

## 9. Test coverage

**88 tests across 8 files** in `src/wayfinding/`:

| File | Pins |
|---|---|
| `autoGraph.test.ts` | derivation, doorway adjacency, cross-floor/cross-site routing, unroutable reasons, real-fixture build |
| `autoGraphStore.test.ts` | overlay merge, dangling-endpoint rejection, conflict detection |
| `router-scale.test.ts` | the 2.5 s bound at 21k nodes |
| `conversation.test.ts` | floor-reference parsing, twin disambiguation, fallback guidance, handoff payload |
| `routeDraw.test.ts` | frame correctness; vertical/degenerate legs dropped |
| `coverage.test.ts` | coverage accounting |
| `plate.test.ts`, `facing.test.ts` | geometry and cone maths |

Plus `wayfinder-ux.test.tsx` (15 tests) at the screen level: guided mode,
mid-route re-anchor, arrival, `?asset=` handoff staleness.

---

## 10. Known limits

Stated plainly; none of these is a bug to be surprised by later.

1. **No live indoor position.** By design — see §5. There is no beacon, UWB or
   wifi-RTT input, and GPS cannot establish a floor.
2. **Google Maps routing is inert.** Both connections are ACTIVE but the org
   has not supplied an `api_key`, so `computeOutdoorRoute` returns null and
   outdoor legs fall back to deep links. `src/api/outdoor.ts` probes once per
   session and treats "not linked" as a normal answer.
3. **Doorways need measured plans.** Schematic floors route hub-and-spoke.
4. **Uncosted edges outrank authored ones** — see the warning in §2.3.
5. **Overlay conflict detection is not a transaction** — see §4.
6. **Rounds routing is unreachable.** `startRound()` has one caller, in a screen
   registered nowhere, so the rounds integration in the Wayfinder is dead in
   practice. Tests pass because they seed `fv.activeRound` directly.

---

## 11. Extending it

**Adding a node kind to the auto-graph:** extend `AutoNodeKind`, emit nodes in
`buildAutoGraph`, and give it edges — an unconnected node is an island the
router will report as unroutable. Update `childrenOf`/`hasChildren` if it
belongs in the hierarchy picker, and `nodeContext` if it needs a label.

**Adding an edge kind:** extend `AutoEdgeKind`, decide its weight, and check
`hopKind` maps it to the right `LegKind` — a kind that falls through to
`indoor` will be drawn as a floor ribbon.

**Changing costs:** the survey graph's defaults are in `router.ts`; the
auto-graph's are the `*_M` constants at the top of `autoGraph.ts`. Both are
covered by tests that assert *ordering*, not absolute values.

**Never**: import `@facilio/vibe-sdk` into `src/wayfinding/**`. The
provider-seam test forbids it, and it is what keeps every module here pure and
testable without a session.
