/**
 * Deep links from AR back into the Facilio web app — the "leave the camera"
 * ornament above an AR window.
 *
 * There is no API that yields the org's web-app URL from inside a Vibe app,
 * and route shapes differ per app link name (see facilio-router: paths are
 * app-relative). So the links are TEMPLATES an admin sets once in Settings,
 * with `{id}` where the record id goes, e.g.
 *   https://acme.facilio.com/maintenance/workorder/{id}/summary
 * No template = no ornament; a wrong link would be worse than none.
 */
import { appStore } from './appStore';

export const LINKS_KEY = 'org.links';

export interface LinkTemplates {
  /** Work-order summary URL template ({id} placeholder). */
  wo: string;
  /** Asset summary URL template ({id} placeholder). */
  asset: string;
}

export const EMPTY_LINKS: LinkTemplates = { wo: '', asset: '' };

export function normaliseLinks(raw: unknown): LinkTemplates {
  const v = (raw ?? {}) as Partial<LinkTemplates>;
  return {
    wo: typeof v.wo === 'string' ? v.wo.trim() : '',
    asset: typeof v.asset === 'string' ? v.asset.trim() : '',
  };
}

/** null when the template is unset or not an http(s) URL — hide the link. */
export function fillLink(template: string, id: number): string | null {
  if (!template || !template.includes('{id}')) return null;
  const url = template.replaceAll('{id}', String(id));
  return /^https?:\/\//i.test(url) ? url : null;
}

export async function loadLinks(): Promise<LinkTemplates> {
  return normaliseLinks(await appStore.kvGet('settings', LINKS_KEY));
}

export async function saveLinks(links: LinkTemplates): Promise<void> {
  await appStore.kvPut('settings', LINKS_KEY, normaliseLinks(links));
}
