/**
 * Importing a floor plan from the browser.
 *
 * Two accepted inputs, because they serve two different people:
 *   - **SVG** — a geometry-only CAD export. The app parses it with the same
 *     extractor the CLI uses, so a facilities user can bind a plan to a floor
 *     without a terminal or a developer. This is the path that matters.
 *   - **JSON** — a plan already extracted offline (or hand-tuned). Validated on
 *     the way in, because a malformed plan does not fail loudly in the 3D engine;
 *     it renders a floor with no walls and looks like the import "worked".
 */
import { extractPlan, PlanExtractError } from './planExtract';
import type { PlanDocument } from './planExtract';

export { PlanExtractError };
export type { PlanDocument };

/** Reject implausible uploads before spending a parse on them. */
const MAX_BYTES = 40 * 1024 * 1024;

const ROLES = ['walls', 'doors', 'glazing', 'stairs', 'furniture'] as const;

export interface ImportedPlan {
  plan: PlanDocument;
  /** Which CAD layers contributed and which were discarded — never silent. */
  report?: { kept: [string, number][]; dropped: [string, number][] };
}

function slugify(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'plan'
  );
}

/**
 * Validate a plan document that did not come from our extractor.
 *
 * Deliberately strict about the things the engine reads without checking:
 * `layers.walls` drives the wall volume, `rooms[].rects` drives the pickable room
 * pads, and `widthM`/`depthM` size the building's plate. A plan missing any of
 * them renders as an empty floor rather than an error.
 */
export function validatePlanDocument(value: unknown, fallbackId: string): PlanDocument {
  const doc = value as Partial<PlanDocument> | null;
  if (!doc || typeof doc !== 'object') throw new PlanExtractError('That file is not a plan object.');

  const widthM = Number(doc.widthM);
  const depthM = Number(doc.depthM);
  if (!Number.isFinite(widthM) || !Number.isFinite(depthM) || widthM <= 0.5 || depthM <= 0.5) {
    throw new PlanExtractError('The plan has no usable widthM / depthM (in metres).');
  }

  const layers = (doc.layers ?? {}) as PlanDocument['layers'];
  if (!layers || typeof layers !== 'object') throw new PlanExtractError('The plan has no layers.');
  for (const role of ROLES) {
    const polys = layers[role];
    if (polys === undefined) {
      (layers as Record<string, unknown>)[role] = [];
      continue;
    }
    if (!Array.isArray(polys)) throw new PlanExtractError(`layers.${role} is not a list of polylines.`);
  }
  if (!Array.isArray(layers.walls) || layers.walls.length === 0) {
    throw new PlanExtractError('The plan has no wall geometry, so there would be nothing to render.');
  }

  const rooms = Array.isArray(doc.rooms) ? doc.rooms : [];
  for (const room of rooms) {
    if (!Array.isArray(room?.rects) || room.rects.length === 0) {
      throw new PlanExtractError('A room in the plan has no rectangles — spaces could not bind to it.');
    }
  }

  return {
    id: typeof doc.id === 'string' && doc.id ? doc.id : fallbackId,
    name: typeof doc.name === 'string' && doc.name ? doc.name : 'Floor plan',
    source: typeof doc.source === 'string' ? doc.source : '',
    widthM,
    depthM,
    rooms,
    layers,
  };
}

/**
 * Turn a picked file into a plan. Throws PlanExtractError with a message meant to
 * be shown to the user as-is; anything else is a genuine bug and propagates.
 */
export async function importPlanFile(file: File): Promise<ImportedPlan> {
  if (file.size > MAX_BYTES) {
    throw new PlanExtractError(
      `That file is ${(file.size / 1024 / 1024).toFixed(0)} MB. Plans are geometry only — ` +
        'this looks like an image export rather than a vector plan.',
    );
  }

  const text = await file.text();
  const looksJson = /\.json$/i.test(file.name) || text.trimStart().startsWith('{');

  if (looksJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PlanExtractError('That .json file is not valid JSON.');
    }
    return { plan: validatePlanDocument(parsed, slugify(file.name)) };
  }

  if (!/<svg[\s>]/i.test(text)) {
    throw new PlanExtractError(
      'That file is neither an SVG plan nor an extracted plan JSON. Export the floor ' +
        'plan as a geometry-only SVG and try again.',
    );
  }

  const id = slugify(file.name);
  const { plan, report } = extractPlan(text, {
    id,
    name: file.name.replace(/\.[^.]+$/, ''),
    source: file.name,
  });

  if (!plan.rooms.length) {
    throw new PlanExtractError(
      'Walls were found, but no enclosed rooms could be recovered from them. The ' +
        'export may be a section or an elevation rather than a floor plan.',
    );
  }

  return { plan, report };
}
