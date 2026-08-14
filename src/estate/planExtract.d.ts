/** Declarations for planExtract.js — see that file for why it stays JavaScript. */

/** One recovered room: its rectangle decomposition plus a bounding box and centroid. */
export interface PlanRoom {
  id: number;
  area: number;
  cx: number;
  cz: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Non-overlapping [x0,z0,x1,z1] rectangles — an L-shaped room is several. */
  rects: number[][];
}

export type PlanRole = 'walls' | 'doors' | 'glazing' | 'stairs' | 'furniture';

export interface PlanDocument {
  id: string;
  name: string;
  source: string;
  widthM: number;
  depthM: number;
  rooms: PlanRoom[];
  /** Polylines in metres, centred on the plate. */
  layers: Record<PlanRole, number[][][]>;
}

export interface PlanExtractReport {
  /** CAD layer name -> path count, for layers that contributed geometry. */
  kept: [string, number][];
  /** CAD layer name -> path count, for layers that were discarded. */
  dropped: [string, number][];
}

export interface PlanExtractOptions {
  id?: string;
  name?: string;
  source?: string;
  /** Raster cell size in metres for room recovery (default 0.05). */
  cell?: number;
  /** Smallest pocket counted as a room, m² (default 2.5). */
  minArea?: number;
  /** Door-opening seal radius in metres (default 0.6). */
  seal?: number;
}

/** Input we can name a reason for. Its message is shown to the user verbatim. */
export declare class PlanExtractError extends Error {}

export declare function extractPlan(
  svg: string,
  opts?: PlanExtractOptions,
): { plan: PlanDocument; report: PlanExtractReport };
