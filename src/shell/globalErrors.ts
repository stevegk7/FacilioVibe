// Global net for errors React boundaries can't see: unhandled promise
// rejections and errors thrown outside the render tree (event handlers that
// escape, async callbacks, third-party script errors).

type Listener = (message: string) => void;

const listeners = new Set<Listener>();
let installed = false;

// React (in dev) rethrows boundary-caught render errors to window, so the
// same crash would hit both the screen's error panel and the global banner.
// Boundaries claim their error; the banner waits a tick and stays quiet for
// claimed ones.
const claimed = new WeakSet<Error>();
const claimedMessages = new Set<string>();

export function claimError(error: Error) {
  claimed.add(error);
  claimedMessages.add(error.message);
  // Messages are only needed for the grace window; don't grow forever.
  setTimeout(() => claimedMessages.delete(error.message), 1000);
}

export function onGlobalError(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(message: string) {
  for (const listener of listeners) listener(message);
}

function emitUnlessClaimed(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : String(error ?? fallback);
  // Give the React commit that runs componentDidCatch a beat to claim it.
  setTimeout(() => {
    if (error instanceof Error && claimed.has(error)) return;
    if (claimedMessages.has(message)) return;
    emit(message);
  }, 50);
}

export function installGlobalErrorHandlers() {
  if (installed) return; // idempotent — React StrictMode double-invokes effects
  installed = true;

  window.addEventListener('unhandledrejection', (event) => {
    emitUnlessClaimed(event.reason, 'Unhandled rejection');
  });

  window.addEventListener('error', (event) => {
    /* A cross-origin script that throws without CORS clearance reaches this
       listener as exactly "Script error." with every useful field stripped —
       no error object, no filename, no stack. Inside the Facilio mobile app
       this fires for the HOST's own bundles, and the red banner it painted
       read as OUR app failing, with nothing anyone could act on. Masked
       errors are logged, not shown; an error the banner can actually name
       still comes through. */
    if (!event.error && !event.filename && /^script error\.?$/i.test(event.message ?? '')) {
      console.warn('[wayfinder] masked cross-origin script error (suppressed from the banner)');
      return;
    }
    emitUnlessClaimed(event.error, event.message || 'Unknown script error');
  });
}
