/**
 * The 3D estate's own types: the raw CMMS rows the loader returns, and the data
 * contract estate-engine.js consumes.
 *
 * These are deliberately NOT the normalised domain types in src/api/types.ts.
 * buildEstate needs tagNumber, localId, manufacturer, model, serialNumber,
 * description, moduleState, commissionedTime, purchasedDate and
 * warrantyExpiryDate on an asset, and floorlevel on a floor — every one of which
 * toAsset()/toFloor() drops — plus list-inspections, which has no domain type at
 * all. Routing the estate through the narrowed types would mean widening four
 * files before a single building rendered; routing raw rows costs nothing and
 * the detail card keeps its real data.
 */

/** A CMMS row as the connection returns it: lookups may be an object or a bare id. */
export interface RawRow {
  id?: number;
  name?: string;
  [field: string]: unknown;
}

export interface EstateRaw {
  sites: RawRow[];
  buildings: RawRow[];
  floors: RawRow[];
  spaces: RawRow[];
  assets: RawRow[];
  workOrders: RawRow[];
  inspections: RawRow[];
  /** planId -> the parsed plan document (bundled or imported). */
  plans: Record<string, unknown>;
  /**
   * floorRecordId -> planId, for plans imported against a specific floor. Takes
   * precedence over the name-regex PLAN_ASSIGNMENTS, so renaming a floor cannot
   * silently swap its drawing.
   */
  planBindings?: Record<number, string>;
  /**
   * True when list-inspections could not be read (the module is not enabled in
   * this org). Lets the UI say "Inspections aren't enabled here" instead of the
   * indistinguishable — and wrong — "0 inspections".
   */
  inspectionsUnavailable?: boolean;
}

export interface EstateStats {
  sites: number;
  buildings: number;
  floors: number;
  spaces: number;
  assets: number;
  workOrders: number;
  openWorkOrders: number;
  inspections: number;
  /** Retired/test records excluded — surfaced so counts never silently disagree. */
  dropped: number;
}

export type MarkerStatus = 'healthy' | 'open' | 'overdue' | 'critical' | 'closed';

/** An asset or work order placed in the scene. */
export interface EstateMarker {
  recordId: number;
  markerModuleName: 'asset' | 'workorder';
  name?: string;
  code?: string;
  category?: string;
  taxonomyId?: string | null;
  status?: MarkerStatus;
  spaceId?: number | null;
  spaceName?: string | null;
  x?: number;
  z?: number;
  [field: string]: unknown;
}

export interface EstateSpace {
  recordId: number;
  name: string;
  spaceCategory?: string | null;
  polygon?: number[][];
  rects?: number[][];
  fromPlan?: boolean;
  [field: string]: unknown;
}

export interface EstateFloor {
  recordId: number;
  /** Derived level code: 'G' | 'B<n>' | 'L<n>'. */
  name: string;
  /** The real Facilio floor name, e.g. "Mechanical Floor". */
  tenantName?: string;
  floorlevel?: number | null;
  buildingName?: string;
  siteName?: string;
  /** Facilio site id — added for the 3D -> AR handoff, which needs to set scope. */
  siteId?: number | null;
  plan?: unknown | null;
  spaces: EstateSpace[];
  markers: EstateMarker[];
  [field: string]: unknown;
}

export interface EstateBuilding {
  /** Engine key — a STRING. The numeric Facilio id is `recordId`. */
  id: string;
  recordId: number;
  name: string;
  siteName?: string;
  /** Facilio site id — see EstateFloor.siteId. */
  siteId?: number | null;
  w: number;
  d: number;
  x: number;
  z: number;
  nF: number;
  floors: EstateFloor[];
  [field: string]: unknown;
}

export interface EstateData {
  name: string;
  buildings: EstateBuilding[];
  siteNames: string[];
  counts: {
    buildings: number;
    floors: number;
    spaces: number;
    assets: number;
    siteLevelAssets: number;
    unresolvedAssets: number;
    planFloors: number;
    planRooms: number;
  };
  /** Per-building shell tints; the screen publishes this to window before construction. */
  tintExtra?: Record<string, unknown>;
  [field: string]: unknown;
}

/* ---------- the engine's imperative surface ---------- */

export interface EngineNav {
  level: 0 | 1 | 2;
  buildingId: string | null;
  floorId: number | null;
}

export interface EngineSelection {
  kind: 'asset' | 'space';
  m?: EstateMarker;
  space?: EstateSpace;
  b?: EstateBuilding;
  f?: EstateFloor;
}

export interface EngineTag {
  recordId: number;
  x: number;
  y: number;
  depth: number;
  selected?: boolean;
  [field: string]: unknown;
}

export interface EngineCallbacks {
  onLevel?(nav: EngineNav): void;
  onSelect?(selection: EngineSelection | null): void;
  onTags?(tags: EngineTag[], spaceTags: EngineTag[]): void;
  onFocus?(recordId: number | null): void;
  onMove?(recordId: number, x: number, z: number): void;
}

export interface EstateEngineApi {
  enterBuilding(buildingId: string): void;
  enterFloor(buildingId: string, floorId: number): void;
  flyToFloor(buildingId: string, floorId: number): void;
  flyToMarker(recordId: number): void;
  locate(recordId: number): { b: EstateBuilding; f: EstateFloor; m: EstateMarker } | null;
  select(recordId: number | null, kind?: 'space'): void;
  focusAsset(recordId: number): void;
  focusSpace(recordId: number): void;
  clearFocus(): void;
  addMarker(buildingId: string, floorId: number, marker: EstateMarker): void;
  updateMarker(recordId: number, patch: Partial<EstateMarker>): EstateMarker | null;
  setScope(scope: {
    canSeeFloor(building: EstateBuilding): boolean;
    canSeeMarker(marker: EstateMarker): boolean;
    showSpaces: boolean;
  }): void;
  setLayers(layers: Record<string, boolean>): void;
  setSearch(query: string): void;
  setEditMode(on: boolean): void;
  /** Added by this app: stop rendering while the canvas is parked off-screen. */
  setPaused(paused: boolean): void;
  /**
   * Added by this app: read a CAD floor as a drawing or as a space.
   * 'drawing' keeps the original 0.85 m wall volume and the near-top-down camera;
   * 'solid' extrudes the same walls to room height and swings the camera oblique.
   */
  setPlanMode(mode: 'drawing' | 'solid'): void;
  getPlanMode(): 'drawing' | 'solid';
  /** Added by this app: repaint the status ramp from the CSS design tokens. */
  setPalette(palette: Record<string, number>): void;
  zoom(direction: number): void;
  back(): void;
  reset(): void;
  getState(): EngineNav;
  dispose(): void;
}

declare global {
  interface Window {
    THREE?: unknown;
    EstateEngine?: new (
      canvas: HTMLCanvasElement,
      data: EstateData,
      callbacks: EngineCallbacks,
    ) => EstateEngineApi;
    AssetTaxonomy?: unknown;
    PlantRoomModels?: unknown;
    FACILIO_TRADES?: unknown;
    FACILIO_ASSET_CATEGORIES?: unknown;
    FACILIO_SPACE_CATEGORIES?: unknown;
    FACILIO_SPACE_GROUPS?: unknown;
    ESTATE_BUILDING_TINT_EXTRA?: Record<string, unknown>;
    __estate?: EstateEngineApi | null;
  }
}
