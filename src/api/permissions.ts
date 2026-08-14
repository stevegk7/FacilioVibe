/**
 * Who may place ASSET markers.
 *
 * Pinning a note, a finding or a work order is field work — anyone doing the
 * job can do it. Placing an asset marker is different: it declares where a
 * piece of the portfolio physically lives, every later scan and route trusts
 * it, and a careless pin is worse than none. So it is gated.
 *
 * There is no role API on the Vibe surface, so the gate is an app setting:
 * open to everyone by default (nothing silently breaks the day this ships),
 * restrictable to a named list by an admin in Settings.
 */
import { appStore } from './appStore';

export const PLACE_ASSET_KEY = 'perm.placeAsset';

export interface PlaceAssetPolicy {
  /** True = anyone signed in. False = only `emails`. */
  allowAll: boolean;
  /** Lower-cased emails allowed when allowAll is false. */
  emails: string[];
}

export const DEFAULT_PLACE_ASSET_POLICY: PlaceAssetPolicy = { allowAll: true, emails: [] };

export function normalisePolicy(raw: unknown): PlaceAssetPolicy {
  const value = (raw ?? {}) as Partial<PlaceAssetPolicy>;
  return {
    allowAll: value.allowAll !== false,
    emails: Array.isArray(value.emails)
      ? value.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
      : [],
  };
}

/** Pure so the rule can be tested without a store or a session. */
export function policyAllows(policy: PlaceAssetPolicy, email: string | undefined): boolean {
  if (policy.allowAll) return true;
  if (!email) return false;
  return policy.emails.includes(email.trim().toLowerCase());
}

export async function loadPlaceAssetPolicy(): Promise<PlaceAssetPolicy> {
  return normalisePolicy(await appStore.kvGet('settings', PLACE_ASSET_KEY));
}

export async function savePlaceAssetPolicy(policy: PlaceAssetPolicy): Promise<void> {
  await appStore.kvPut('settings', PLACE_ASSET_KEY, normalisePolicy(policy));
}
