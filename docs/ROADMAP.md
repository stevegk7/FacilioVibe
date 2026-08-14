# Facilio Vision — phases 3–8

Phases 1–2 are built (see PRs #2–#5). This is the plan for the rest, annotated
with two things the tables alone don't carry:

1. **Verified platform facts** — slugs and quirks confirmed against org #2915
   on 2026-08-13. Trust these over guesses; re-verify anything marked ⚠.
2. **Reuse pointers** — two sibling repos already solve big parts of phases
   3–7: `asset-lens` (camera + recognition + AR) and `ppm-asset-tagging`
   (connected-app embedding + filter lore). Lift, don't rewrite.

Design: all UI follows the **Vision AR System** design project
(claude.ai/design `4a77f71a…`) — Facilio Atom tokens (`src/styles/tokens.css`),
chip taxonomy (state / context / action), placement grid A–F, marker family
(asset tag / note tag / WO pin / standpoint / minimized dot), no native
browser controls (use `DsSelect` etc.).

---

## Phase 3 · Camera (~5 days)

| # | Work | Reuse |
|---|---|---|
| 3.1 | `useCamera` state machine (live/paused/denied/unavailable) | `asset-lens/src/components/camera/useCamera.ts` — lift as-is (193 lines, self-contained) |
| 3.2 | `muted`/`playsInline` as **properties before play()**; rejected play/pause → state + tap-to-start | already encoded in the same file; the ordering comment is load-bearing |
| 3.3 | Canvas mirror for hosted mode (video 2px invisible, blit ~30fps) | `asset-lens/src/components/camera/CameraView.tsx` — includes the `ImageCapture.grabFrame()` webview bypass (never calls play() inside the Facilio app) |
| 3.4 | Frame grab ≤960px + still capture | `useCamera.ts` exports `makeThumb()` / `cropBlob()` |
| 3.5 | Embed-aware camera-unavailable screen with "open in browser" | pattern in `CameraView.tsx` (swap the hardcoded asset-lens URL) |
| 3.6 | **Webview flags ask to the mobile team** — file it week one | `allowsInlineMediaPlayback=true`, `mediaTypesRequiringUserActionForPlayback=[]`, `setMediaPlaybackRequiresUserGesture(false)` |
| 3.7 | Real-device pass (browser + Facilio app, iPhone + Android) | manual checklist — automated tests cannot prove this |

## Phase 4 · Recognition (~9 days)

| # | Work | Reuse |
|---|---|---|
| 4.1 | MobileNet v2 1280-d embedder, lazy chunk, idle warmup | `asset-lens/src/vision/embedder.ts` (dim probed at load, WebGL fallback, deterministic stub for tests) |
| 4.2 | int8+base64 quantised vectors, per-vector scale, `modelId` stamped | `asset-lens/src/vision/quantize.ts` (~1.7KB vs ~12KB per vector) |
| 4.3 | Cosine matcher, per-site index | `asset-lens/src/vision/matcher.ts` (renormalize after dequantize; per-asset max-pool; brute force is fine <2k vectors) |
| 4.4 | Quality gates (brightness/sharpness/motion) | `asset-lens/src/vision/quality.ts` — 64×64 luma, <5ms, thresholds: luma<40 dark, sharp<3.5 blur, motion>9 moving |
| 4.5 | Capture flow (photo→location→markers→crops→upload→save) | pattern in `asset-lens/src/screens/CaptureScreen.tsx`: photo+thumb parallel, 15s model race, `embeddingStatus:'pending'` fallback |
| 4.6 | Scan loop (QR first → gate → embed → top-3 → auto-lock) | `ScanScreen.tsx` `tick()` ~L735: 300ms tick, embed ≥500ms apart self-tuned to `embedCost*4` cap 1500ms, mean of last 2 embeddings, accept 0.6 + margin 0.08 |
| 4.7 | QR lane: BarcodeDetector + jsQR fallback, typed codes, **conflict sheet not a guess** | `asset-lens/src/vision/qr.ts` (+ `extractAssetId` for Facilio QR URL shapes, `qrVal` format `facilio_<id>` verified live); code registry lives in our `fv_codes` KV |
| 4.8 | Rooms browser | new UI on `appStore.kvList('surveys')` + `getPhotoUrl` |

Storage: vectors go in KV per the asset-lens shape — key
`emb::<siteId>::<captureId>::<markerIdx>`, value `{assetId, modelId, q, s, dim}`;
fetch per site in one `kvList('codes'|'surveys', prefix)` bundle.

## Phase 5 · AR engine (~7 days) — do NOT run in parallel with Phase 4 in the same files

| # | Work | Reuse |
|---|---|---|
| 5.1 | 3DoF orientation (compass+pitch, EMA, ~0.4° deadband) | new; asset-lens has partial art in `src/ar/` |
| 5.2 | Damped follower, snap past ~12° | new |
| 5.3 | **Node registry, not React state** — rAF writes transforms to DOM | non-negotiable per roadmap: React re-render per frame collapsed the webview to unusable; DOM writes sustained 120fps |
| 5.4 | Bearing-order declutter | new |
| 5.5 | Marker family w/ live status colours | design foundations 03 — statuses map red `--danger-500` open reactive / amber `--warning-500` planned / green `--success-500` clear |
| 5.6 | Drag re-place, minimize, board cap, per-site persistence | persist board in `fv_settings` KV |
| 5.7 | HUD: context chip, ONE state chip, action rail, candidates, crosshair | design foundations 01–02: max 2 context + 1 state + 3 actions, candidates max 3 + overflow, state chip suppresses second context chip |

## Phase 6 · Survey + AR maintenance (~14 days)

Keystone: **6.1 markers stored relative to sweep frame 0** — absolute compass
bearings are 5–30° wrong indoors and differently wrong per day; relative
storage cancels the error. Relocaliser exists: `asset-lens/src/vision/relocalize.ts`
(2 consecutive same-survey matches, score ≥0.52, rolling median of 7 deltas) — 6.5.
Surveys/standpoints/QR registry → `fv_surveys` + `fv_codes` KV. WO panel
in-view (6.9) reuses PR #4's `WorkOrderPanel` + status catalogue; raise-a-fault
uses the **script lane** (`scriptFns.ts`) because `create-work-order` is broken
(see PR #4). Δ-corrected rendering + presence decay (6.7): QR evidence trusted
far longer than sight; never distance-gate a scanned label.

## Phase 7 · Field operations (~5 days)

| # | Work | Reuse |
|---|---|---|
| 7.1 | Offline write queue | `asset-lens/src/api/offlineQueue.ts` — decorator over the provider; queues ONLY network-shaped failures (regex + navigator.onLine), FIFO replay on `online`, rejected writes never block the queue |
| 7.2 | Rounds + CSV export | new; definitions in `fv_settings`, stops stamped into `fv_surveys` |
| 7.3 | Performance pass | adaptive cadence exists in the scan loop; **no backdrop-filter in the webview** |

## Phase 8 · Voice + AI assist (~4 days)

- 8.1 agents (identify / draft-WO-from-photo / transcribe-nameplate): single
  typed output schema + `"none"` sentinel; built via `facilio vibe agent`
  (⚠ verify that CLI surface when starting — not yet exercised).
- 8.2 push-to-talk local intents (status/start/pause/pin/rescan).
- 8.3 free-form fallback = **client-side tool loop** — the model asks, the app
  executes, result goes back. **Never give an agent server-side tools: they
  invent record ids.** The `executeAgent` result arrives as a JSON *string* —
  `JSON.parse(res.response.content)` (the most common agent bug per platform docs).

---

## Verified platform facts (org #2915, 2026-08-13)

- `facilio-cmms` list actions share `{page, page_size, filters, sort_by,
  sort_order, select, expand, include_count}` → `{data, count, pagination}`.
- Filters: `field(is)=a,b` for IN (bare `id=a,b` returns an HTML error page);
  single-match filters collapse to an object (`rowsOf`); failures reported
  in-band at HTTP 200; an invalid field in `select`/`expand` nulls the
  response silently (workorder has NO `siteId` field — its location filter is
  `site`, assets attach via `space` only).
- WO rows: `moduleState`/`priority` come back as plain strings; asset link is
  `resource`. Status catalogue = `get-work-order-metadata` →
  `moduleState.allowed_values`; transitions via `change-work-order-status
  {id, status:<internal name>}`.
- **`create-work-order` is broken at the platform level** (schema demands
  `siteId` object, backend demands Long — mutually exclusive). Use the script
  lane: `facilio_vision.createRecord` scriptengine fn → `Module(m).v3Add(data)`
  (self-provisions via `facilio-platform` actions; see `src/api/scriptFns.ts`).
- App DB: role has **no DDL** — tables only via `facilio vibe db import` (CSV,
  all columns text, no constraints → no `on conflict`; fvApi upserts are
  update-then-insert). Env in functions: `SCHEMA`/`DB_USER`/`DB_PASSWORD` via
  `process.env` (confirmed in vibe-server `FunctionRunUtil.buildEnv`).
- Files: `vibe.uploadFile(blob, name)` → `{fileId}`; SDK-only, no CLI lane;
  never set multipart Content-Type by hand.
