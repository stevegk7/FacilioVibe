// Domain types for the provider seam. Field names mirror the real
// facilio-cmms action responses (verified via `facilio connections execute`)
// so the mock and real providers are interchangeable.

export interface Site {
  id: number;
  name: string;
  description?: string;
  siteType?: string;
  moduleState?: string;
  qrVal?: string;
}

export interface Building {
  id: number;
  name: string;
  siteId?: number;
}

export interface Floor {
  id: number;
  name: string;
  buildingId?: number;
  siteId?: number;
  /** Facilio's own storey index — orders floors and phrases "up 3 floors". */
  floorLevel?: number;
}

/**
 * A BaseSpace row with its ancestry flattened. Assets attach to the location
 * tree through `space` ONLY — an asset's space pointer can target any level
 * (site, building, floor, or space), so scope resolution needs all of these.
 */
export interface Space {
  id: number;
  name: string;
  siteId?: number;
  buildingId?: number;
  floorId?: number;
  spaceType?: string;
}

export interface Asset {
  id: number;
  name: string;
  category?: string;
  /** The BaseSpace the asset parents to — may be a site/building/floor id. */
  spaceId?: number;
  spaceName?: string;
  qrVal?: string;
}

export interface WorkOrder {
  id: number;
  subject: string;
  description?: string;
  /** moduleState label, e.g. "Open" / "Closed" — comes back as a plain string. */
  status?: string;
  priority?: string;
  /** The Space/Asset lookup ("resource") this WO is raised against. */
  resourceId?: number;
  resourceName?: string;
  assignedTo?: string;
  /**
   * The assignee's record id, kept because the display NAME cannot answer
   * "is this mine?" — two people share a name, and the scoping rule that hides
   * one technician's work from another must not turn on a string match.
   *
   * Measured on org #2915 (WO 14275667): this is a THIRD id space — 2282340,
   * which is neither the org user id nor the employee record id. So the id is
   * kept, but `isMine()` in scope.ts leans on `assignedToEmail`, which is the
   * only key that reliably identifies the same person.
   */
  assignedToId?: number;
  assignedToEmail?: string;
  dueDate?: string; // UTC ISO 8601 — convert to local time before rendering
  createdTime?: string;
}

/**
 * One button the org's published state flow says this record offers RIGHT NOW.
 *
 * Not the status catalogue: `getWorkOrderStatuses` returns every status the
 * module defines and the UI fakes transitions by removing the current one,
 * which offers moves the workflow forbids. This comes from the flow itself,
 * already filtered for the record's state, the caller's permissions, its
 * approval status and each button's criteria — so it is the truth, and it is
 * why none of these names are hardcoded anywhere in the app.
 */
export interface RecordAction {
  buttonId: number;
  /** 'stateTransition' | 'approval' | 'customButton' | 'systemButton'. */
  buttonType: string;
  name: string;
  /** systemButtons only — 'print', 'download', … */
  identifier?: string;
  toStateId?: number;
  /** Present when the transition collects input before it will run. */
  form?: RecordActionForm;
}

export interface RecordActionForm {
  id?: number;
  displayName?: string;
  fields?: RecordActionField[];
}

export interface RecordActionField {
  name: string;
  displayName?: string;
  required?: boolean;
  /** e.g. 'text', 'number', 'team-staff-assignment' — org-configured. */
  displayType?: string;
}

/** Everything the flow offers on one record, plus where it currently sits. */
export interface RecordActions {
  currentState?: { id?: number; displayName?: string; status?: string };
  stateTransitions: RecordAction[];
  approvalTransitions: RecordAction[];
  customButtons: RecordAction[];
  systemButtons: RecordAction[];
}

/** One entry of the status catalogue (workorder.moduleState allowed_values). */
export interface WorkOrderStatus {
  label: string;
  /** Internal status name — what change-work-order-status expects. */
  value: string;
}

export interface WorkOrderTask {
  id: number;
  subject: string;
  closed: boolean;
}

export interface WorkOrderDraft {
  subject: string;
  description?: string;
  /** Plain numeric ids — the script lane takes them as-is. */
  siteId?: number;
  resourceId?: number;
  /** BaseSpace the work physically belongs to (asset's space, or the survey's
   * floor/building) — this is what puts site/building/space on the record. */
  spaceId?: number;
}

/** Where the user is working. Narrower fields win (floor > building > site). */
export interface LocationScope {
  siteId?: number;
  buildingId?: number;
  floorId?: number;
}

export interface AssetSearch {
  /** Case-insensitive name match (server-side `name(contains)=`). */
  text?: string;
  scope?: LocationScope;
}

/** Query params shared by every facilio-cmms list action (verified schema). */
export interface ListQuery {
  page?: number;
  pageSize?: number; // max 200
  /** `field(operator)=value` pairs joined by `&`, e.g. `name(contains)=Tower` */
  filters?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /** Comma-separated field projection */
  select?: string;
  /** Comma-separated lookup fields to hydrate (max 5) */
  expand?: string;
  includeCount?: boolean;
}

export interface PageResult<T> {
  data: T[];
  page: number;
  pageSize: number;
  /** Present only when the query asked for includeCount */
  totalCount?: number;
}

// ---- app-store domain (surveys, codes, rounds — stored as KV JSON) ----

/** A geolocation sample. Indoors this is often absent — callers treat null as normal. */
export interface GeoFix {
  lat: number;
  lng: number;
  /** Metres (from Geolocation API). */
  accuracy: number;
  /** Epoch ms when sampled. */
  at: number;
}

/** One auto-captured frame of a 360° sweep. */
export interface SweepFrame {
  /** Absolute device heading at capture (deg 0-360). Frame 0's heading is the survey's reference. */
  heading: number;
  pitch: number;
  /** int8+base64 quantised embedding {q, s, dim} (vision/quantize). */
  vec: { q: string; s: number; dim: number };
  /** 64-bin column-luma profile (src/ar/imageShift) — lets relocalization
   * measure the SUB-FRAME rotation instead of quantizing Δ to ~28° frames. */
  profile?: number[];
  /**
   * The frame's own photo in the app file store.
   *
   * Sweeps used to keep only the embedding, which is enough to recognise a
   * room but shows a vendor nothing. Keeping the image too turns the sweep
   * into a look-around of the room with the markers drawn on it — which is
   * what someone arriving cold actually needs. Optional: surveys captured
   * before this simply have no viewer.
   */
  fileId?: number;
}

/**
 * A placed marker. heading/pitch are RELATIVE TO SWEEP FRAME 0 — absolute
 * compass bearings are 5-30° wrong indoors and differently wrong per day;
 * relative storage makes the error cancel. Render with:
 *   abs = (sweep[0].heading + marker.heading + relocΔ + 360) % 360
 */
export interface SurveyMarker {
  id: string;
  label: string;
  heading: number;
  pitch: number;
  assetId?: number;
  workOrderId?: number;
  note?: string;
  /** Distance from the standpoint (m), when known — lets the renderer
   * reproject the marker as the viewer walks (see parallaxCorrected). */
  rangeM?: number;
}

export interface Survey {
  id: string;
  name: string;
  siteId?: number;
  buildingId?: number;
  floorId?: number;
  spaceName?: string;
  geo: GeoFix | null;
  /** Standpoint QR code value, when enrolled. */
  qrCode?: string;
  /** Device heading while FACING the QR at enrolment — scanning it later gives Δ instantly. */
  qrHeading?: number;
  standpointFileId?: number;
  sweep: SweepFrame[];
  markers: SurveyMarker[];
  /** Embedder identity — vectors from another model never mix. */
  modelId: string;
  createdAt: string;
  createdBy?: string;
}

/** Typed QR registry entry (fv_codes). A code identifies exactly ONE thing. */
export interface CodeEntry {
  code: string;
  type: 'asset' | 'space' | 'floor' | 'survey';
  assetId?: number;
  spaceId?: number;
  floorId?: number;
  surveyId?: string;
  createdAt: string;
}

export interface RoundStop {
  surveyId: string;
  /** Proof of presence for a completed stop. */
  via?: 'qr' | 'visual' | 'manual';
  at?: string;
  note?: string;
}

export interface Round {
  id: string;
  name: string;
  siteId?: number;
  /** Ordered surveys to visit. */
  stops: RoundStop[];
  startedAt?: string;
  finishedAt?: string;
}

/** Per-site coordinates for outdoor wayfinding legs (admin-editable). */
export interface SiteGeo {
  siteId: number;
  lat: number;
  lng: number;
}

/** Shape of vibe.getCurrentUser() — fields are nested, there is no me.email. */
export interface CurrentUser {
  user: {
    uid: number;
    email: string;
    name: string;
    username: string;
  };
  org: {
    orgId: number;
  };
}
