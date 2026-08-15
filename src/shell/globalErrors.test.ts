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
});
