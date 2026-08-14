/**
 * Declarations for buildEstate.js — see that file for why it stays JavaScript.
 *
 * TypeScript resolves this .d.ts; Vite and Node resolve the .js beside it.
 * `allowJs` must stay OFF in tsconfig.json, or the two collide on one module name.
 */
import type { EstateData, EstateRaw, EstateStats } from './types';

/** Counts for the raw record lists — shared by the loader and the dev harness. */
export declare function statsOf(raw: EstateRaw): EstateStats;

/**
 * Lay out the estate. Pure and deterministic: the same records always produce
 * the same geometry, because every placement is seeded off the record's own id.
 *
 * Reads the vendored taxonomy off `window`, so loadEngine() must have resolved
 * before this is called — a missing taxonomy does not throw, it silently
 * degrades every asset to a generic box.
 */
export declare function buildEstate(
  raw: EstateRaw,
  opts?: { sampleHealth?: boolean },
): EstateData;

/**
 * Overlay generated work orders and asset condition on the REAL hierarchy, so
 * the criticality colouring can be reviewed in an org with little live work.
 * Mutates and returns the estate. Nothing is written back to Facilio.
 */
export declare function applySampleHealth(estate: EstateData): EstateData;
