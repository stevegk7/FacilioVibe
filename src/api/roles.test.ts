// Role decides whether you see your own work or everyone's, so the interesting
// cases are the failure ones: an unknown email, a store that will not answer,
// and junk written into the map by hand.
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_ADMINS,
  can,
  normaliseRoleMap,
  resolveRole,
  type RoleMap,
} from './roles';

const MAP: RoleMap = { admins: ['lead@facilio.com'] };

describe('role resolution', () => {
  it('denies an unlisted email once administrators HAVE been configured', () => {
    expect(resolveRole('someone@facilio.com', MAP)).toEqual({
      role: 'technician',
      source: 'default',
    });
  });

  it('treats an EMPTY list as unconfigured, not as everyone-denied', () => {
    // The trap this closes: a technician's Settings hides the card that edits
    // the list, so deny-by-default on an empty list locks the org out of its
    // own permissions with nobody able to grant them.
    expect(resolveRole('anyone@facilio.com', { admins: [] })).toEqual({
      role: 'admin',
      source: 'unconfigured',
    });
    expect(resolveRole('anyone@facilio.com', null).source).toBe('unconfigured');
  });

  it('never lets an unconfigured list overrule an explicit platform "not admin"', () => {
    // The regression this closes: with no administrators configured, the
    // first-run rule promoted EVERYONE — so a technician the platform had
    // already flagged as non-admin saw every work order in the org.
    expect(resolveRole('tech@facilio.com', { admins: [] }, false, false)).toEqual({
      role: 'technician',
      source: 'default',
    });
    expect(resolveRole('tech@facilio.com', null, false, false).role).toBe('technician');
  });

  it('closes the gate the moment one administrator is named', () => {
    expect(resolveRole('anyone@facilio.com', { admins: ['lead@facilio.com'] }).role).toBe(
      'technician',
    );
  });

  it('promotes an email the admin listed', () => {
    expect(resolveRole('lead@facilio.com', MAP)).toEqual({ role: 'admin', source: 'map' });
  });

  it('matches case- and whitespace-insensitively, as the store is hand-edited', () => {
    expect(resolveRole('  LEAD@Facilio.COM ', MAP).role).toBe('admin');
    expect(normaliseRoleMap({ admins: ['  Lead@Facilio.com '] }).admins).toEqual([
      'lead@facilio.com',
    ]);
  });

  it('resolves a bootstrap admin WITHOUT the store, so deny-by-default cannot lock Settings', () => {
    // The motivating failure: fvApi is not promoted on this channel, every read
    // degrades to empty, and the only screen that could fix the list is admin-only.
    expect(resolveRole(BOOTSTRAP_ADMINS[0], null, true)).toEqual({
      role: 'admin',
      source: 'bootstrap',
    });
  });

  it('reports an unreadable store as its own reason rather than a real denial', () => {
    // Same answer, different reason — the UI can then say "couldn't read
    // permissions" instead of implying someone deliberately restricted you.
    expect(resolveRole('someone@facilio.com', null, true)).toEqual({
      role: 'technician',
      source: 'unavailable',
    });
  });

  it('denies a signed-out user with no email, once configured', () => {
    expect(resolveRole(undefined, MAP).role).toBe('technician');
    expect(resolveRole('', MAP).role).toBe('technician');
  });

  it('survives junk in the store rather than throwing at whoever signed in', () => {
    expect(normaliseRoleMap(null)).toEqual({ admins: [] });
    expect(normaliseRoleMap({ admins: 'not-an-array' })).toEqual({ admins: [] });
    // admins:null normalises to an EMPTY list, which is "unconfigured".
    expect(resolveRole('lead@facilio.com', normaliseRoleMap({ admins: null })).source).toBe(
      'unconfigured',
    );
  });
});

describe('capabilities', () => {
  it('gives an admin every capability', () => {
    expect(can('admin', 'wo.viewAll')).toBe(true);
    expect(can('admin', 'diagnostics.view')).toBe(true);
    expect(can('admin', 'people.manage')).toBe(true);
  });

  it('lets a technician raise work but never see or reassign anyone else’s', () => {
    expect(can('technician', 'wo.create')).toBe(true);
    expect(can('technician', 'wo.viewAll')).toBe(false);
    expect(can('technician', 'wo.assign')).toBe(false);
    expect(can('technician', 'wo.delete')).toBe(false);
  });

  it('keeps every admin surface off the technician', () => {
    for (const capability of [
      'diagnostics.view',
      'settings.admin',
      'people.manage',
      'dashboard.org',
      'survey.manage',
      'round.manage',
      'portfolio.edit',
      'asset.edit',
      'estate.viewAll',
      'ar.configure',
      'wayfinder.edit',
    ] as const) {
      expect(can('technician', capability)).toBe(false);
    }
  });
});

describe('the platform’s own admin flag', () => {
  // getCurrentUser returns `admin: boolean` alongside user and org. Missing it
  // shipped a release where real administrators arrived as technicians, so
  // these pin that it is consulted FIRST and needs nothing else to work.
  it('makes a platform administrator an admin, whatever the list says', () => {
    expect(resolveRole('nobody@facilio.com', MAP, false, true)).toEqual({
      role: 'admin',
      source: 'platform',
    });
  });

  it('works with no email and an unreachable store — it needs neither', () => {
    expect(resolveRole(undefined, null, true, true).role).toBe('admin');
  });

  it('does NOT demote someone the app listed but the platform does not flag', () => {
    // admin:false is the platform saying "not an org admin", not "deny" — this
    // app may still grant CAFM admin from its own list.
    expect(resolveRole('lead@facilio.com', MAP, false, false)).toEqual({
      role: 'admin',
      source: 'map',
    });
    expect(resolveRole(BOOTSTRAP_ADMINS[0], null, false, false).role).toBe('admin');
  });

  it('still denies an unlisted, unflagged user', () => {
    expect(resolveRole('someone@facilio.com', MAP, false, false).role).toBe('technician');
  });
});
