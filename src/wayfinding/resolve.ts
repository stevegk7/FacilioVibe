/**
 * Destination resolution — one definition of "which standpoint do I route to
 * for this asset / this place", shared by the Wayfinder screen and the voice
 * tool loop so the two can never disagree about whether something is mapped.
 *
 * The assistant research pattern this feeds: the AI is a GROUNDED RESOLVER —
 * it turns language into an entity from a closed set, and the terminal act is
 * starting a route, never composing prose directions. Resolution itself is
 * deterministic code; the agent only enters when plain search comes up empty.
 */
import type { Survey } from '../api/types';
import type { WayGraph, WayNode } from './graph';
import { nodeForSurvey } from './graph';

export interface PlaceRef {
  kind: 'site' | 'building' | 'floor' | 'space';
  id: number;
}

/** The survey whose markers pin this asset — the routable proxy for it. */
export function surveyForAsset(surveys: Survey[], assetId: number): Survey | undefined {
  return surveys.find((s) => s.markers.some((m) => m.assetId === assetId));
}

/** A survey standing IN the named place — how a room/floor/building routes. */
export function surveyForPlace(surveys: Survey[], place: PlaceRef): Survey | undefined {
  return surveys.find((s) =>
    place.kind === 'building'
      ? s.buildingId === place.id
      : place.kind === 'floor'
        ? s.floorId === place.id
        : place.kind === 'site'
          ? s.siteId === place.id
          : false,
  );
}

/** Asset → its graph node, when pinned and derivable. */
export function nodeForAsset(
  graph: WayGraph,
  surveys: Survey[],
  assetId: number,
): { node: WayNode; survey: Survey } | null {
  const survey = surveyForAsset(surveys, assetId);
  if (!survey) return null;
  const node = nodeForSurvey(graph, survey.id);
  return node ? { node, survey } : null;
}
