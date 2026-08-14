// Placing an ASSET marker declares where the portfolio physically lives, and
// every later scan and route trusts it — so it is gated, while notes,
// findings and work orders stay ordinary field work.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLACE_ASSET_POLICY,
  normalisePolicy,
  policyAllows,
} from '../api/permissions';

describe('place-asset policy', () => {
  it('is open by default — shipping the gate must not lock everyone out', () => {
    expect(DEFAULT_PLACE_ASSET_POLICY.allowAll).toBe(true);
    expect(policyAllows(DEFAULT_PLACE_ASSET_POLICY, 'anyone@facilio.com')).toBe(true);
    expect(policyAllows(DEFAULT_PLACE_ASSET_POLICY, undefined)).toBe(true);
  });

  it('restricts to the named list once an admin turns allowAll off', () => {
    const policy = { allowAll: false, emails: ['lead@facilio.com'] };
    expect(policyAllows(policy, 'lead@facilio.com')).toBe(true);
    expect(policyAllows(policy, 'vendor@facilio.com')).toBe(false);
  });

  it('matches emails case- and whitespace-insensitively', () => {
    const policy = normalisePolicy({ allowAll: false, emails: ['  Lead@Facilio.com '] });
    expect(policy.emails).toEqual(['lead@facilio.com']);
    expect(policyAllows(policy, 'LEAD@facilio.COM')).toBe(true);
  });

  it('denies an unknown signed-out user when restricted — never falls open', () => {
    expect(policyAllows({ allowAll: false, emails: ['lead@facilio.com'] }, undefined)).toBe(false);
  });

  it('survives junk in the store rather than throwing at a technician', () => {
    expect(normalisePolicy(null)).toEqual({ allowAll: true, emails: [] });
    expect(normalisePolicy({ allowAll: false, emails: 'not-an-array' })).toEqual({
      allowAll: false,
      emails: [],
    });
  });
});
