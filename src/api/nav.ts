/**
 * System navigation into Facilio — `openSummary` via the connected-app
 * bridge, which redirects BY DEFAULT with zero configuration.
 *
 * When the vibe app runs embedded in Facilio (the host renders it in an
 * iframe/webview and passes ?origin= & capp_id=), the SDK's ConnectedApp
 * interface can ask the HOST to open a record — the host owns its own
 * routes, so the link is always right, on web and on mobile alike.
 *
 * Standalone in a plain browser there is no host to message, so callers
 * fall back to the Settings URL templates (src/api/links).
 */
import { initConnectedApp, type ConnectedApp } from '@facilio/vibe-sdk';

/** The host supplies these params when it embeds the app — their presence
 * IS the detection. */
export function isEmbeddedInFacilio(): boolean {
  if (typeof window === 'undefined') return false;
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return Boolean(
    (search.get('origin') ?? hash.get('origin')) &&
      (search.get('capp_id') ?? hash.get('capp_id')),
  );
}

let appPromise: Promise<ConnectedApp> | null = null;

function host(): Promise<ConnectedApp> {
  appPromise ??= initConnectedApp();
  return appPromise;
}

/**
 * Open a record's summary through the host. Resolves true when the system
 * navigation handled it; false when there is no host (caller falls back).
 */
export async function openRecordSummary(
  module: 'workorder' | 'asset',
  id: number,
  newtab = true,
): Promise<boolean> {
  if (!isEmbeddedInFacilio()) return false;
  try {
    const app = await host();
    await app.ready;
    await app.interface.openSummary({ module, id }, newtab);
    return true;
  } catch {
    return false; // a broken bridge degrades to the template link
  }
}
