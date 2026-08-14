/**
 * Which CMMS records this app shows at all — ONE definition, shared.
 *
 * The two apps that merged into this one disagreed. Estate Navigator dropped
 * test artifacts before laying out geometry; Facilio Vision listed everything.
 * Against org #2915 that is not a cosmetic difference: 16 of 55 assets, 16 of 76
 * spaces, 4 of 17 floors and 1 of 5 buildings are named "OBSOLETE (CLI test
 * artifact - safe to delete)". Left unreconciled, the 3D estate would show 39
 * assets while Portfolio showed 55, and nothing would tell the user which count
 * was lying.
 *
 * So the predicate lives here and is applied in the data layer, where every
 * screen inherits it. It is idempotent — filtering an already-filtered list is
 * the same list — which is what lets buildEstate keep its own defensive pass for
 * the offline geometry checks that feed it raw fixtures directly.
 *
 * Plain JS with a hand-written .d.ts on purpose: smoke-adapter.mjs imports the
 * geometry path from Node, and Node cannot load a .ts file.
 */

/** Test artifacts and retired records, by the naming convention this org uses. */
export const RETIRED_NAME = /obsolete|safe to delete|\[fv-verify\]/i;

/** True when a row is a retired or test record rather than real estate data. */
export function isRetired(row) {
  return !!row && RETIRED_NAME.test(String(row.name ?? ''));
}

/**
 * Drop retired rows. `showRetired` is the escape hatch behind the Settings
 * toggle — an admin auditing what the CLI left behind still needs to see them.
 */
export function visibleRows(rows, showRetired = false) {
  if (showRetired) return rows ?? [];
  return (rows ?? []).filter((row) => !isRetired(row));
}
