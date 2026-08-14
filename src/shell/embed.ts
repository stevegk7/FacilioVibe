export interface EmbedInfo {
  embedded: boolean;
  cappId: string | null;
  origin: string | null;
}

const STORAGE_KEY = 'fv.embed';

/**
 * Connected-app detection. The Facilio host passes `capp_id` (and often
 * `origin`) as query params when it embeds us. We detect on THOSE params —
 * never on window.parent/iframe checks, because the mobile host is a native
 * webview, which is top-level and would defeat any iframe test.
 *
 * The result is persisted to sessionStorage: internal navigation rewrites the
 * query string, and losing the params must not drop us out of embedded layout.
 */
export function detectEmbed(search: string = window.location.search): EmbedInfo {
  const params = new URLSearchParams(search);
  const cappId = params.get('capp_id');
  const origin = params.get('origin');

  if (cappId !== null || origin !== null) {
    const info: EmbedInfo = { embedded: true, cappId, origin };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(info));
    return info;
  }

  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      return JSON.parse(stored) as EmbedInfo;
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }

  return { embedded: false, cappId: null, origin: null };
}
