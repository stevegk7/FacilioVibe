# Facilio Vision 3D

One app for the estate and the field: a **3D model of the buildings** you can drill
into from a desk, and a **camera view** of the same equipment for the technician
standing in front of it — with a handoff in both directions.

It is the merge of two Facilio Vibe apps that were each half of this:

| Merged from | What it brought |
|---|---|
| [Facilio Vision](https://github.com/RajkumarSenthil02/facilio-vision) | The field half — AR camera stage, compass-anchored markers, standpoint QR + visual relocalization, indoor wayfinding, inspection rounds, and Effi (voice) over five Studio agents |
| [Estate Navigator](https://github.com/stevegk7/Interactive-3D-facility-explorer-main) | The desk half — a three.js estate model: estate → building (exploding floor stack) → floor, with two real CAD floor plans |

App `facilio-vision-3d`, org **Facilio Vetri Kazhagam (#2915)**, region US.
Preview: <https://preview-facilio-vision-3d.vibe.facilio.com/>

> Every `facilio vibe deploy` lands on the **preview** URL. Production is a
> separate step — see [Going live](#going-live).

## What it does

**3D Estate** is the navigation spine. Four buildings, thirteen floors, sixty
spaces and thirty-nine assets, read live from Facilio CMMS. Two floors render
true architectural geometry extracted from CAD exports; the rest use a schematic
layout derived from real containment (stated in the viewport footer — it is a
schematic, not a survey).

**AR** is the same estate from inside it: point the camera, see the markers, open
a work order, raise a fault from a photo.

**Floor plans** can be imported from inside the app — open a floor, pick a CAD SVG
(or a plan JSON extracted offline), and it binds to *that* floor. The app parses
the drawing and recovers its rooms itself; no CLI, no developer. On any floor with
a plan, a **Drawing / 3D** toggle reads it either as architectural line work seen
from above or as room-height walls you orbit as a space — and **Walk in** puts you
inside it at eye level, drag to look, WASD or the on-screen pad to walk, with the
drawn walls as the ones you bump into.

**The handoff** is the point of the merge:

- *In 3D, on an asset* → **Find it on site**. The app resolves the destination
  before it navigates, so the button can tell you what will happen: it opens AR
  when a surveyed standpoint has that asset pinned, routes through Wayfinder when
  the floor is surveyed but the asset is not, and when nothing is mapped it
  **stays put and says so** — with *Survey this floor* and *Directions to site* as
  the two real next actions. Sending someone to a screen that cannot help them
  would be worse than declining.
- *In AR, on an asset* → **Show in 3D**. The model flies to it. A scan or a visual
  lock deliberately does *not* auto-navigate; yanking a technician out of the
  camera mid-task would be wrong.
- *Ask Effi* — "show me tower A level three in 3D", "take me to chiller one",
  "where am I". Same voice assistant on both surfaces.

## Layout

```
index.html               PWA shell. The 3D globals are NOT script tags here — see below.
vibe.json                app: facilio-vision-3d, build.publish: dist
public/
  estate-engine.js       the three.js scene (vendored, patched — see docs/)
  plantroom-models.js    procedural 3D model per asset category
  asset-category-taxonomy.js  facilio-taxonomy.js
  plans/*.json           extracted CAD floor plans
src/
  api/                   the provider seam — the ONLY place that touches the SDK
    estate.ts            the estate's transport, on the shared paging helpers
    recordPolicy.js      one definition of "which records this app shows"
  estate/
    buildEstate.js       pure: records -> engine geometry (+ .d.ts)
    planExtract.js       pure: CAD SVG -> plan JSON; the CLI wraps this same module
    planImport.ts        browser import: SVG or JSON, validated
    planStore.ts         plan file + the floor binding in KV
    loadEngine.ts        lazy-loads three + the four globals, in order
    estateHost.ts        the canvas outlives React, so tab switches are free
    findOnSite.ts        resolves the handoff BEFORE navigating
  screens/EstateScreen.tsx   the 3D screen
  shell/router.ts        goToTab — cross-screen navigation
  ar/ vision/ voice/ wayfinding/ rounds/ …   the field half, unchanged
agents/                  five prompt + schema files (source of truth)
functions/fvApi/         the KV app store + its seed CSVs
smoke-adapter.mjs        `npm run check`    — geometry + record accounting, offline
smoke-plan3d.mjs         `npm run check:3d` — the three.js CAD path, offline
```

### Why the 3D runtime is not in `index.html`

Estate Navigator loaded three.js in its entry bundle and the four vendored globals
as blocking `<script>` tags — about 180 KB gzip parsed on every page load. In a
merged app that bill lands on the technician who only ever opens the camera.

`src/estate/loadEngine.ts` injects them on first 3D use instead. Verified on the
deployed app: opening `?tab=ar` fetches the entry chunk and nothing else — no
three, no engine, no CAD plans.

Three things are load-bearing there, each with a silent failure mode if broken:
`window.THREE` before the first `new EstateEngine(...)`; the taxonomy globals
before `buildEstate()` runs (missing, every asset degrades to a generic grey box
with no error); and `script.async = false`, because dynamically-created scripts
default to `true` and would let the engine run before the taxonomy exists.

## Working on it

```bash
npm install
npm run verify     # build (typecheck + vite) + tests + both offline checks + bundle budget
npm run dev        # ?mock=1 renders the whole app, 3D included, with no Facilio session
facilio vibe deploy
```

`npm run dev` cannot load live data — auth is cookie-based on the
`*.vibe.facilio.com` origin. Use `?mock=1`.

`npm run check:bundle` is the guard that keeps the estate off the AR path: it
fails if three.js appears in the entry chunk or the entry exceeds its gzip budget.

## Going live

`facilio vibe deploy` publishes to the **preview** URL only. Promotion to
production is **a click in the Facilio platform UI, and only the user can make
it** — open the app in Vibe Studio and press *Publish to production*.

**`facilio vibe deploy --prod` does not do it.** The flag is real (CLI 0.10.5)
and it really does POST `{production: true}` to the deployments endpoint, but
the server does not treat that as a promotion: the deploy succeeds, reports the
**preview** URL, and the app's `publishedAt` stays null. Tested on v12 of this
app; `facilio vibe app list` is the check, since its `PUBLISHED` column is that
field. The docs are the authoritative side of this disagreement, and they are
explicit that it is deliberate — *"no `vibe promote` … by design. This is a
safety property, not an option you can override."* There is no app-level
publish command anywhere in the CLI; the only `/publish` endpoint it calls is
per-deployment and means "finish uploading this build", not "make it live".

The `fvApi` function is promoted **per channel** — a build promoted without it
answers 404 on every KV call, at which point reads degrade to empty and writes
throw. After promoting, confirm with:

```bash
facilio vibe function run fvApi health
```

Preview and production **share one database**. From the first preview write,
preview is writing production data.

## Notes carried over

- **Filtering is one policy, in the data layer.** Sixteen of this org's
  fifty-five assets are named `OBSOLETE (CLI test artifact - safe to delete)`.
  Estate Navigator hid them, Facilio Vision listed them — so the 3D view would
  have said 39 assets while Portfolio said 55. `src/api/recordPolicy.js` is now
  the single definition, applied in both providers.
- **`PLAN_ASSIGNMENTS` names this org's buildings** (`/^Tower A$/i` + `/^Floor 1$/i`).
  It belongs in the settings KV so an admin can bind a plan without a deploy.
  Filed, not fixed.
- **three.js is pinned to exactly 0.128.0.** r152 turned colour management on by
  default and r155 went physically-correct; either would re-grade the whole
  scene. `npm run check:3d` fails if the pin moves.
