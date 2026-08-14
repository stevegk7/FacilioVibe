/**
 * The demo wayfinding dataset — one builder, two id universes.
 *
 * The same journey shape (entrance → lobby → lift → mechanical floor → plant
 * room, plus a server-room detour) is expressed against MOCK ids for ?mock=1
 * (seeded into localStorage KV by src/api/seedDemoData.ts) and LIVE ids for
 * org #2915 (written through fvApi by tools/seed-wayfinding.mjs). One builder
 * means the demo cannot drift between the two universes.
 *
 * Every edge instruction is LANDMARK-FIRST on purpose: the research this
 * screen was rebuilt on (docs/WAYFINDING.md) found landmark phrasing beats
 * distances on wrong-turn rate and confidence, and the hand-authored edge is
 * exactly where a human supplies what no router can derive.
 *
 * Surveys carry synthetic sweep vectors and NO fileIds — photos cannot be
 * seeded through any lane (uploads are SDK-only), and every reader treats
 * both as optional.
 */
import type { CodeEntry, Survey } from '../api/types';
import type { WayGraph } from './graph';

interface DemoPlace {
  buildingId: number;
  floorId: number;
  /** Facilio floorlevel, for the lift/stairs "up N floors" phrasing. */
  level: number;
}

export interface DemoIdMap {
  siteId: number;
  /** Where the entrance + lobby standpoint live. */
  lobby: DemoPlace & { spaceName: string };
  /** The mechanical floor: lift landing + plant room standpoints. */
  mech: DemoPlace;
  /** The detour standpoint (server room). May be another building. */
  server: DemoPlace;
  /** How the lobby→server walk reads (same building vs across a plaza). */
  serverWalk: { meters: number; instruction: string };
  plantAssets: Array<{ id: number; label: string }>;
  serverAsset: { id: number; label: string };
  buildingName: string;
  /** Site centroid; also seeds entrance/lobby geo for the GPS entrance pick. */
  lat: number;
  lng: number;
}

/** Mock universe — ids from src/api/mockProvider.ts fixtures. Plant room and
 * reception are Tower B; the server room (UPS-A2, which carries an OPEN work
 * order) is Tower A's ground floor, reached across the plaza. */
export const MOCK_DEMO_IDS: DemoIdMap = {
  siteId: 1001,
  lobby: { buildingId: 1502, floorId: 1804, level: 1, spaceName: 'Reception' },
  mech: { buildingId: 1502, floorId: 1805, level: 2 },
  server: { buildingId: 1501, floorId: 1802, level: 0 },
  serverWalk: {
    meters: 60,
    instruction: 'Cross the plaza to Tower A — the server room is off the lobby, badged door',
  },
  plantAssets: [
    { id: 3007, label: 'Chiller CH-02' },
    { id: 3008, label: 'Primary Pump P-01' },
  ],
  serverAsset: { id: 3002, label: 'UPS-A2' },
  buildingName: 'Tower B',
  lat: 12.9716,
  lng: 77.5946,
};

/** Live universe — org #2915, Greenfield Business Park, all in Tower A. */
export const LIVE_DEMO_IDS: DemoIdMap = {
  siteId: 2282068,
  lobby: { buildingId: 2282113, floorId: 2282115, level: 0, spaceName: 'Lobby' },
  mech: { buildingId: 2282113, floorId: 2282140, level: 3 },
  server: { buildingId: 2282113, floorId: 2282123, level: 1 },
  serverWalk: {
    meters: 25,
    instruction: 'Left out of the lift — the server room is the badged door at the end',
  },
  plantAssets: [
    { id: 2282142, label: 'Chiller TA-CH-01' },
    { id: 2282143, label: 'Air Handling Unit TA-AHU-01' },
    { id: 2282144, label: 'Primary Chilled Water Pump TA-P-01' },
  ],
  serverAsset: { id: 2282131, label: 'Precision AC Unit TA-PAC-01' },
  buildingName: 'Tower A',
  lat: 12.9716,
  lng: 77.5946,
};

/** Matches the embedder identity the app stamps on surveys (src/ar/embedding.ts). */
const DEMO_MODEL_ID = 'luma64-v0';
const CREATED_AT = '2026-08-14T09:00:00.000Z';

/** A tiny deterministic sweep — enough shape to satisfy every reader that
 * filters on `Array.isArray(markers)` and to render a believable detail. */
function sweep(baseHeading: number) {
  return Array.from({ length: 4 }, (_, i) => ({
    heading: (baseHeading + i * 90) % 360,
    pitch: 0,
    vec: { q: '', s: 1, dim: 0 },
  }));
}

export interface DemoDataset {
  surveys: Survey[];
  codes: CodeEntry[];
  graph: WayGraph;
  sitegeo: { siteId: number; lat: number; lng: number };
}

export function buildDemoDataset(ids: DemoIdMap): DemoDataset {
  const surveys: Survey[] = [
    {
      id: 'demo-lobby',
      name: `${ids.buildingName} — ${ids.lobby.spaceName}`,
      siteId: ids.siteId,
      buildingId: ids.lobby.buildingId,
      floorId: ids.lobby.floorId,
      spaceName: ids.lobby.spaceName,
      geo: { lat: ids.lat, lng: ids.lng, accuracy: 8, at: Date.parse(CREATED_AT) },
      qrCode: 'fv-sv-demo-lobby',
      qrHeading: 40,
      sweep: sweep(40),
      markers: [],
      modelId: DEMO_MODEL_ID,
      createdAt: CREATED_AT,
    },
    {
      id: 'demo-mech-landing',
      name: 'Mechanical Floor — Lift Landing',
      siteId: ids.siteId,
      buildingId: ids.mech.buildingId,
      floorId: ids.mech.floorId,
      spaceName: 'Lift Landing',
      geo: null,
      qrCode: 'fv-sv-demo-landing',
      qrHeading: 130,
      sweep: sweep(130),
      markers: [],
      modelId: DEMO_MODEL_ID,
      createdAt: CREATED_AT,
    },
    {
      id: 'demo-plant',
      name: 'Plant Room — door',
      siteId: ids.siteId,
      buildingId: ids.mech.buildingId,
      floorId: ids.mech.floorId,
      spaceName: 'Plant Room',
      geo: null,
      qrCode: 'fv-sv-demo-plant',
      qrHeading: 220,
      sweep: sweep(220),
      markers: ids.plantAssets.map((a, i) => ({
        id: `dm-p${i + 1}`,
        label: a.label,
        heading: (20 + i * 55) % 360,
        pitch: i === 0 ? -5 : 0,
        assetId: a.id,
      })),
      modelId: DEMO_MODEL_ID,
      createdAt: CREATED_AT,
    },
    {
      id: 'demo-server',
      name: 'Server Room — rack row',
      siteId: ids.siteId,
      buildingId: ids.server.buildingId,
      floorId: ids.server.floorId,
      spaceName: 'Server Room',
      geo: null,
      qrCode: 'fv-sv-demo-server',
      qrHeading: 310,
      sweep: sweep(310),
      markers: [
        {
          id: 'dm-s1',
          label: ids.serverAsset.label,
          heading: 45,
          pitch: 0,
          assetId: ids.serverAsset.id,
        },
      ],
      modelId: DEMO_MODEL_ID,
      createdAt: CREATED_AT,
    },
  ];

  const codes: CodeEntry[] = surveys.map((s) => ({
    code: s.qrCode as string,
    type: 'survey',
    surveyId: s.id,
    createdAt: CREATED_AT,
  }));

  // Whether the server room is up the lobby's own lift (live: Tower A Floor 1)
  // or across the plaza in another building (mock: Tower A ground) decides how
  // it joins the graph — the walk instruction rides the DemoIdMap.
  const serverViaLift = ids.server.buildingId === ids.lobby.buildingId;

  // Hand-authored nodes only — standpoints derive from the surveys at load
  // (graph.ts withSurveyNodes) and the editor strips them on save, so storing
  // them here would only create clobber hazards.
  const graph: WayGraph = {
    siteId: ids.siteId,
    nodes: [
      {
        id: 'n-demo-entrance',
        kind: 'entrance',
        name: `${ids.buildingName} — Main Entrance`,
        buildingId: ids.lobby.buildingId,
        floorId: ids.lobby.floorId,
        floorLevel: ids.lobby.level,
        lat: ids.lat + 0.0001,
        lng: ids.lng + 0.0001,
      },
      {
        id: 'n-demo-lift-g',
        kind: 'lift',
        name: 'Lift A — Lobby level',
        buildingId: ids.lobby.buildingId,
        floorId: ids.lobby.floorId,
        floorLevel: ids.lobby.level,
      },
      ...(serverViaLift
        ? [
            {
              id: 'n-demo-lift-1',
              kind: 'lift' as const,
              name: 'Lift A — Floor 1',
              buildingId: ids.server.buildingId,
              floorId: ids.server.floorId,
              floorLevel: ids.server.level,
            },
          ]
        : []),
      {
        id: 'n-demo-lift-m',
        kind: 'lift',
        name: 'Lift A — Mechanical Floor',
        buildingId: ids.mech.buildingId,
        floorId: ids.mech.floorId,
        floorLevel: ids.mech.level,
      },
      {
        id: 'n-demo-stairs-g',
        kind: 'stairs',
        name: 'Stairwell B — Lobby level',
        buildingId: ids.lobby.buildingId,
        floorId: ids.lobby.floorId,
        floorLevel: ids.lobby.level,
      },
      {
        id: 'n-demo-stairs-m',
        kind: 'stairs',
        name: 'Stairwell B — Mechanical Floor',
        buildingId: ids.mech.buildingId,
        floorId: ids.mech.floorId,
        floorLevel: ids.mech.level,
      },
    ],
    edges: [
      {
        id: 'e-demo-1',
        from: 'n-demo-entrance',
        to: 'sv:demo-lobby',
        kind: 'walk',
        meters: 12,
        instruction: 'Through the glass doors — reception is on your right',
      },
      {
        id: 'e-demo-2',
        from: 'sv:demo-lobby',
        to: 'n-demo-lift-g',
        kind: 'walk',
        meters: 18,
        instruction: 'Pass reception; the lift lobby is behind the green feature wall',
      },
      // Lift and stairs carry honest metres so the router's choice between
      // them reflects the building, not the kind-default cost table.
      { id: 'e-demo-3', from: 'n-demo-lift-g', to: 'n-demo-lift-m', kind: 'lift', meters: 10 },
      {
        id: 'e-demo-4',
        from: 'n-demo-lift-m',
        to: 'sv:demo-mech-landing',
        kind: 'door',
        meters: 5,
        instruction: "Through the fire door marked 'Plant'",
      },
      {
        id: 'e-demo-5',
        from: 'sv:demo-mech-landing',
        to: 'sv:demo-plant',
        kind: 'walk',
        meters: 12,
        instruction: 'Follow the yellow floor line past the fire-hose cabinet',
      },
      ...(serverViaLift
        ? [
            { id: 'e-demo-6a', from: 'n-demo-lift-g', to: 'n-demo-lift-1', kind: 'lift' as const, meters: 6 },
            {
              id: 'e-demo-6b',
              from: 'n-demo-lift-1',
              to: 'sv:demo-server',
              kind: 'walk' as const,
              meters: ids.serverWalk.meters,
              instruction: ids.serverWalk.instruction,
            },
          ]
        : [
            {
              id: 'e-demo-6',
              from: 'sv:demo-lobby',
              to: 'sv:demo-server',
              kind: 'walk' as const,
              meters: ids.serverWalk.meters,
              instruction: ids.serverWalk.instruction,
            },
          ]),
      {
        id: 'e-demo-7',
        from: 'sv:demo-lobby',
        to: 'n-demo-stairs-g',
        kind: 'walk',
        meters: 22,
        instruction: 'Stairwell B is past the goods lift, grey double doors',
      },
      { id: 'e-demo-8', from: 'n-demo-stairs-g', to: 'n-demo-stairs-m', kind: 'stairs', meters: 42 },
      {
        id: 'e-demo-9',
        from: 'n-demo-stairs-m',
        to: 'sv:demo-mech-landing',
        kind: 'door',
        meters: 4,
        instruction: 'Out of the stairwell, the lift landing is straight ahead',
      },
    ],
    updatedAt: CREATED_AT,
  };

  return {
    surveys,
    codes,
    graph,
    sitegeo: { siteId: ids.siteId, lat: ids.lat, lng: ids.lng },
  };
}
