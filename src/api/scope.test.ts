// The gate that decides whether a technician sees another technician's work.
// The cases that matter are the ambiguous ones: an unhydrated lookup, a second
// id space, and a row carrying no assignment information at all.
import { describe, expect, it } from 'vitest';
import {
  allowedPlaces,
  assetIdsFrom,
  canReadWorkOrder,
  isMine,
  visibleAssets,
  visibleWorkOrders,
  type SessionScope,
} from './scope';
import type { Asset, Space, WorkOrder } from './types';

const TECH: SessionScope = {
  role: 'technician',
  uid: 7,
  employeeId: 11038324195,
  email: 'tech@facilio.com',
};
const ADMIN: SessionScope = { role: 'admin', uid: 1, email: 'admin@facilio.com' };

const wo = (over: Partial<WorkOrder>): WorkOrder => ({ id: 1, subject: 'WO', ...over });

describe('is this work order mine', () => {
  it('matches the employee id space — the one work-order assignment actually uses', () => {
    expect(isMine(wo({ assignedToId: 11038324195 }), TECH)).toBe(true);
  });

  it('also matches the org user id, because which space arrives is not yet settled', () => {
    expect(isMine(wo({ assignedToId: 7 }), TECH)).toBe(true);
  });

  it('matches on email when the lookup carried one', () => {
    expect(isMine(wo({ assignedToEmail: 'TECH@facilio.com' }), TECH)).toBe(true);
  });

  it('reads an unexpanded lookup that arrived as a bare id', () => {
    // No expand applied: the server sends a number where an object was wanted.
    expect(isMine({ assignedTo: 11038324195 }, TECH)).toBe(true);
  });

  it('reads an expanded lookup object', () => {
    expect(isMine({ assignedTo: { id: 7, name: 'Tech' } }, TECH)).toBe(true);
  });

  it('never matches on display name — two people share a name', () => {
    expect(isMine({ assignedTo: { name: 'Tech' } }, TECH)).toBe(false);
    expect(isMine(wo({ assignedTo: 'Tech' }), TECH)).toBe(false);
  });

  it('fails closed when the row says nothing about assignment', () => {
    expect(isMine(wo({}), TECH)).toBe(false);
  });

  it('is not mine when it belongs to someone else', () => {
    expect(isMine(wo({ assignedToId: 999, assignedToEmail: 'other@facilio.com' }), TECH)).toBe(
      false,
    );
  });
});

describe('work order visibility', () => {
  const rows = [
    wo({ id: 1, assignedToId: 7 }),
    wo({ id: 2, assignedToId: 999 }),
    wo({ id: 3 }),
  ];

  it('shows an admin everything, untouched', () => {
    expect(visibleWorkOrders(rows, ADMIN)).toHaveLength(3);
  });

  it('shows a technician only their own', () => {
    expect(visibleWorkOrders(rows, TECH).map((r) => r.id)).toEqual([1]);
  });

  it('is idempotent, so a defensive second pass downstream is free', () => {
    const once = visibleWorkOrders(rows, TECH);
    expect(visibleWorkOrders(once, TECH)).toEqual(once);
  });

  it('survives an undefined list rather than throwing at whoever is on site', () => {
    expect(visibleWorkOrders(undefined, TECH)).toEqual([]);
  });

  it('refuses a direct read of someone else’s work order — the typed-URL case', () => {
    expect(canReadWorkOrder(wo({ id: 2, assignedToId: 999 }), TECH)).toBe(false);
    expect(canReadWorkOrder(wo({ id: 1, assignedToId: 7 }), TECH)).toBe(true);
    expect(canReadWorkOrder(wo({ id: 2, assignedToId: 999 }), ADMIN)).toBe(true);
    expect(canReadWorkOrder(null, ADMIN)).toBe(false);
  });
});

describe('deriving the places a technician may see', () => {
  const assets: Asset[] = [
    { id: 3001, name: 'AHU-03', spaceId: 2001 },
    { id: 3009, name: 'Other', spaceId: 2002 },
    // Parents straight to a SITE, not a leaf space — the real quirk fixture
    // asset 3006 preserves, and the reason every level is collected.
    { id: 3006, name: 'Site-parented', spaceId: 1001 },
  ];
  const spaces: Space[] = [
    { id: 2001, name: 'Plant Room', siteId: 1001, buildingId: 1101, floorId: 1201 },
    { id: 2002, name: 'Server Room', siteId: 1002, buildingId: 1102, floorId: 1202 },
  ];

  it('collects the asset ids a work order set is raised against', () => {
    expect([...assetIdsFrom([{ resourceId: 3001 }, { resourceId: 3001 }, {}])]).toEqual([3001]);
  });

  it('walks asset → space → floor, building and site', () => {
    const places = allowedPlaces(assets, spaces, new Set([3001]));
    expect(places.spaceIds.has(2001)).toBe(true);
    expect(places.floorIds.has(1201)).toBe(true);
    expect(places.buildingIds.has(1101)).toBe(true);
    expect(places.siteIds.has(1002)).toBe(false); // the other technician's site
  });

  it('handles an asset parented directly to a site', () => {
    const places = allowedPlaces(assets, spaces, new Set([3006]));
    expect(places.siteIds.has(1001)).toBe(true);
  });

  it('narrows assets to the ones the work reaches, and leaves an admin alone', () => {
    expect(visibleAssets(assets, new Set([3001]), TECH).map((a) => a.id)).toEqual([3001]);
    expect(visibleAssets(assets, new Set([3001]), ADMIN)).toHaveLength(3);
  });

  it('gives a technician with no assigned work an empty world, not the whole org', () => {
    const places = allowedPlaces(assets, spaces, new Set());
    expect(places.buildingIds.size).toBe(0);
    expect(visibleAssets(assets, new Set(), TECH)).toEqual([]);
  });
});

describe('the real row shape from org #2915', () => {
  // Captured from work order 14275667 on 2026-08-15, the first WO in the org
  // ever given an assignee. Until it existed, which id space `assignedTo`
  // used was guesswork; this pins the answer so it stops being.
  const REAL_ROW = {
    id: 14275667,
    subject: 'test yaamz',
    assignedTo: { id: 2282340, name: 'Technician Yaaminy', email: 'yaaminy.sk+technician@facilio.com' },
  };

  const TECH: SessionScope = {
    role: 'technician',
    // What getCurrentUser reports, and what list-employees reports. NEITHER is
    // the id on the row.
    uid: 2281806,
    employeeId: 11038324195,
    email: 'yaaminy.sk+technician@facilio.com',
  };

  it('matches on EMAIL, because the assignee id is a third id space', () => {
    // 2282340 is neither the org user id (2281806, what createdBy carries) nor
    // the employee record id (11038324195, what list-employees returns). Had
    // this matched on id alone it would have shown the technician nothing.
    expect(REAL_ROW.assignedTo.id).not.toBe(TECH.uid);
    expect(REAL_ROW.assignedTo.id).not.toBe(TECH.employeeId);
    expect(isMine(REAL_ROW, TECH)).toBe(true);
  });

  it('still refuses the same row to a different technician', () => {
    expect(isMine(REAL_ROW, { ...TECH, email: 'someone.else@facilio.com' })).toBe(false);
  });

  it('matches despite the + in the address, which breaks server-side filters', () => {
    // Plus-addressing cannot be filtered on server-side (ONBOARDING §6), which
    // is exactly why this comparison happens here in JS.
    expect(TECH.email).toContain('+');
    expect(isMine(REAL_ROW, TECH)).toBe(true);
  });
});
