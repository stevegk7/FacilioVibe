/* ---------- real CAD floor plans ----------
 * Sample architectural plans, extracted from geometry-only SVG exports by tools/extract-plan.mjs
 * (walls / doors / glazing / furniture line work, plus rooms recovered by raster flood-fill).
 * Each is pinned to a real Facilio floor: that floor then renders true measured geometry instead
 * of the schematic room boxes, and its Facilio spaces bind onto the plan's detected rooms.
 */
/* NOTE on the pairing: nothing in Facilio ties a space record to a room in a drawing — there is no
   shared key — so binding is positional (biggest room to first space) and the choice of which floor
   gets which plan is ours. These two were picked to cover both cases: an office plan on an office
   floor, and a plan on the equipment-heavy mechanical floor so plant renders inside real rooms. */
/* These regexes name THIS org's buildings and floors. That is a known limitation carried over
   from Estate Navigator: the pairing belongs in the settings KV collection so an admin can bind a
   plan without a deploy. Filed, not fixed, because moving it changes no pixel in v1. */
export const PLAN_ASSIGNMENTS = [
  { plan: 'ats-level1', building: /^Tower A$/i, floor: /^Floor 1$/i },
  { plan: 'albalawi-ground', building: /^Tower B$/i, floor: /^Mechanical Floor$/i },
];
