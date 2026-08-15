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
    if (isUnattributable(event)) {
      // Logged in full, never bannered — see isUnattributable for why.
      console.warn(
        '[wayfinder] script error from outside this app, suppressed from the banner:',
        event.message,
        event.error,
      );
      return;
    }
    emitUnlessClaimed(event.error, event.message || 'Unknown script error');
  });
}

/**
 * True when nothing on this page's script graph can be blamed for the error.
 *
 * The banner exists for OUR failures. Two kinds of foreign error were reaching
 * it and reading, to a technician, as this app crashing — with nothing they
 * could act on:
 *
 *  - a cross-origin script without CORS clearance, which arrives as exactly
 *    "Script error." with every field stripped (the Facilio host app's own
 *    bundles do this when the app runs inside it);
 *  - a script the BROWSER injects into the page, which is how Brave Shields'
 *    cosmetic filtering reported `undefined is not an object (evaluating
 *    'n.standardSelectors')` on a technician's phone. Brave has a documented
 *    history of load-order races in that content script, and it runs in the
 *    page's main world on iOS, so its throws land on our window.
 *
 * Both share one property, confirmed by measuring real ErrorEvents rather than
 * guessing: they name NO source. An injected inline script reports
 * `filename: ""` and a stack whose every frame is `<anonymous>`. Our own
 * errors always name one — `filename` is the module, and even when the TOP
 * frame is native (`at WeakMap.set (<anonymous>)`) a later frame names the
 * file. So the whole stack is scanned, not just its head.
 *
 * Deliberately conservative. Anything we can attribute, and anything we cannot
 * inspect at all, is shown; only the two shapes above are dropped.
 */
function isUnattributable(event: ErrorEvent): boolean {
  if (event.filename) return false; // a source file owns it

  const stack = event.error instanceof Error ? event.error.stack : undefined;
  if (typeof stack === 'string' && stack.trim()) return !stackNamesASource(stack);

  /* No stack to reason about. Only the classic masked shape is foreign here;
     any other message is specific enough to be worth showing even though we
     cannot place it. */
  return /^(uncaught )?script error\.?$/i.test(event.message ?? '');
}

/**
 * Does any frame of this stack name a file?
 *
 * Matches a URL scheme or a script file extension, so it holds for a bundle
 * (`https://…/index-abc.js:1:200`), a dev module
 * (`http://localhost:5173/src/wayfinding/autoGraph.ts:274:16`) and a stack
 * under the test runner, where frames are bare paths with no scheme at all
 * (`/Users/…/globalErrors.test.ts:39:21`). A browser-injected script matches
 * none of them: its frames are `at <anonymous>:1:23`.
 *
 * The first line is the message, not a frame — skipped, so an error whose TEXT
 * happens to mention a filename cannot vouch for itself.
 */
function stackNamesASource(stack: string): boolean {
  return stack
    .split('\n')
    .slice(1)
    .some((frame) => /:\/\/|\.[cm]?[jt]sx?[:)]/.test(frame));
}
