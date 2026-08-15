// The global error banner's contract: real errors reach the listener, masked
// ones do not.
//
// "Masked" is the cross-origin case: a script served from another origin that
// throws without CORS clearance surfaces as literally "Script error." with the
// error object, filename and stack all stripped. Inside the Facilio mobile app
// this fires for the HOST's own bundles — so the banner was painting a red,
// unactionable alarm over a healthy app, which is worse than saying nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobalErrorHandlers, onGlobalError } from './globalErrors';

// The install is module-global and idempotent; one install serves every test.
installGlobalErrorHandlers();

function fireError(init: ErrorEventInit) {
  window.dispatchEvent(new ErrorEvent('error', { ...init, cancelable: true }));
}

describe('global error banner', () => {
  let seen: string[];
  let off: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
    off = onGlobalError((m) => seen.push(m));
  });

  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  it('surfaces a real error, message intact', () => {
    fireError({ error: new Error('estate runtime: graph_model.js failed'), message: 'boom' });
    vi.advanceTimersByTime(100); // past the claim grace window
    expect(seen).toEqual(['estate runtime: graph_model.js failed']);
  });

  it('stays quiet for a masked cross-origin "Script error." — logs instead', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fireError({ message: 'Script error.' }); // no error object, no filename
    fireError({ message: 'Script error' }); // some engines drop the period
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does NOT treat a same-origin error as masked just because its text matches', () => {
    // A filename means the event was not stripped — show it, whatever it says.
    fireError({ message: 'Script error.', filename: 'https://app/assets/index.js' });
    vi.advanceTimersByTime(100);
    expect(seen).toEqual(['Script error.']);
  });

  /* The shapes below were MEASURED in a real browser, not invented: an inline
     script injected into the page (how Brave Shields' cosmetic filtering runs
     on iOS) versus a throw from inside this app's own module. Both were
     captured off window's error event and are reproduced verbatim. */
  it('stays quiet for a browser-injected script — the Brave Shields case', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const injected = new Error("undefined is not an object (evaluating 'n.standardSelectors')");
    // Measured: no filename, and every frame anonymous — it names no source.
    injected.stack = `TypeError: undefined is not an object (evaluating 'n.standardSelectors')
    at <anonymous>:1:23
    at <anonymous>:1:44`;
    fireError({ message: `Uncaught ${injected.message}`, filename: '', error: injected });
    vi.advanceTimersByTime(100);

    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still shows OUR error when only the TOP frame is native', () => {
    // Measured from a real throw inside src/wayfinding/autoGraph.ts. The head
    // frame is native; a scan of just the head would have hidden a real bug.
    const ours = new Error('Invalid value used as weak map key');
    ours.stack = `TypeError: Invalid value used as weak map key
    at WeakMap.set (<anonymous>)
    at cacheFor (http://localhost:5173/src/wayfinding/autoGraph.ts:274:16)`;
    fireError({ message: 'Uncaught TypeError: Invalid value used as weak map key', filename: '', error: ours });
    vi.advanceTimersByTime(100);

    expect(seen).toEqual(['Invalid value used as weak map key']);
  });

  it('shows an unnamed error it cannot inspect, rather than assuming it is foreign', () => {
    // No filename and no Error object to read a stack from: attribution is
    // impossible, so the conservative move is to surface it.
    fireError({ message: 'Something broke in a way we cannot attribute' });
    vi.advanceTimersByTime(100);
    expect(seen).toEqual(['Something broke in a way we cannot attribute']);
  });
});
