/**
 * "Find it on site" — resolve where a handoff from the 3D model should land,
 * BEFORE navigating.
 *
 * The point of resolving first is that the button can say what it will do, and
 * that the one case with no good destination stops rather than dumping the user
 * on a screen that cannot help. That honesty is the same rule the voice tool
 * loop already follows: it answers "not mapped" rather than inventing corridors.
 *
 * Step 1 is deliberately the same predicate defaultDeps.routeToAsset uses to
 * decide whether an asset is pinned, extracted so "is this asset reachable in
 * AR" has exactly one definition in the app.
 */
import { appStore } from '../api/appStore';
import type { LocationScope, Survey } from '../api/types';

export type FindOnSitePlan =
  | {
      /** A surveyed standpoint has a marker for this asset: AR can point at it. */
      kind: 'ar';
      surveyId: string;
      surveyName: string;
      scope: LocationScope;
      caption: string;
    }
  | {
      /** No pin, but the floor is surveyed: route them there and say so. */
      kind: 'wayfinder';
      scope: LocationScope;
      caption: string;
    }
  | {
      /** Nothing mapped anywhere in this building — do not navigate. */
      kind: 'unsurveyed';
      scope: LocationScope;
      caption: string;
    };

export interface FindOnSiteTarget {
  assetId: number;
  assetName?: string;
  scope: LocationScope;
  /** For the copy — "Tower A · Floor 3". */
  placeLabel?: string;
}

/** Every survey with usable markers, newest-shape-tolerant. */
async function loadSurveys(): Promise<Survey[]> {
  const rows = await appStore.kvList<Survey>('surveys', 'survey.', 200);
  return rows.map((r) => r.value).filter((s): s is Survey => !!s && Array.isArray(s.markers));
}

/**
 * Widen from the narrowest scope outward — floor, then building, then site —
 * mirroring how the provider resolves an asset's location. A standpoint one
 * floor away is still a better answer than nothing.
 */
function surveyNear(surveys: Survey[], scope: LocationScope): Survey | undefined {
  if (scope.floorId) {
    const onFloor = surveys.find((s) => s.floorId === scope.floorId);
    if (onFloor) return onFloor;
  }
  if (scope.buildingId) {
    const inBuilding = surveys.find((s) => s.buildingId === scope.buildingId);
    if (inBuilding) return inBuilding;
  }
  if (scope.siteId) return surveys.find((s) => s.siteId === scope.siteId);
  return undefined;
}

export async function planFindOnSite(target: FindOnSiteTarget): Promise<FindOnSitePlan> {
  const { assetId, assetName, scope, placeLabel } = target;
  const asset = assetName ?? `Asset #${assetId}`;
  const place = placeLabel ?? 'this floor';

  let surveys: Survey[] = [];
  try {
    surveys = await loadSurveys();
  } catch {
    // The app store being unreachable is not a reason to claim nothing is
    // surveyed — fall through to the routing answer, which degrades honestly.
    surveys = [];
  }

  const pinned = surveys.find((s) => s.markers.some((m) => m.assetId === assetId));
  if (pinned) {
    return {
      kind: 'ar',
      surveyId: pinned.id,
      surveyName: pinned.name,
      scope: {
        siteId: pinned.siteId ?? scope.siteId,
        buildingId: pinned.buildingId ?? scope.buildingId,
        floorId: pinned.floorId ?? scope.floorId,
      },
      caption: `Pinned at ${pinned.name} — AR will point straight at it.`,
    };
  }

  if (surveyNear(surveys, scope)) {
    return {
      kind: 'wayfinder',
      scope,
      caption: `${asset} isn't pinned yet — routing you to ${place}; the last stretch is on you.`,
    };
  }

  return {
    kind: 'unsurveyed',
    scope,
    caption: `Nobody has surveyed ${place} yet, so there's no indoor route and no AR pin.`,
  };
}
