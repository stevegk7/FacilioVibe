// What an error surface shows when the platform answers with a web page.
//
// Reproduces a live failure (2026-08-15): execute-button-for-a-record returned
// 502 and the SDK's error message carried the ENTIRE response body — the
// Facilio web client's index.html, doctype, source comments, font links — which
// the AR panel then painted, red, at a technician standing in front of the
// asset. The panel is for "what happened and what do I do"; the page is noise.
import { describe, expect, it } from 'vitest';
import { humanError, isGatewayFailure } from './facilioHelpers';

// Abridged from the actual screenshot; the shape is what matters.
const GATEWAY_PAGE =
  'executeAction facilio-record-level-button-actions/execute-button-for-a-record failed: 502 — ' +
  '<!doctype html> <html lang="en"> <head> <!-- DEMO DAY — TEMPORARY, DELETE AFTER Tue, Aug 18 2026 ' +
  '(the event date): `Instrument+Serif` is the display face for the Demo Day invitation banner ' +
  '(src/layouts/common/DemoDayBanner.vue). --> <link href="https://fonts.googleapis.com/css2?family=Roboto">';

describe('humanError', () => {
  it('replaces an HTML error page with one actionable sentence, keeping the status', () => {
    const out = humanError(new Error(GATEWAY_PAGE), 'execute-button-for-a-record');
    expect(out.message).toContain('HTTP 502');
    expect(out.message).toContain('Try again');
    expect(out.message).not.toMatch(/<|doctype|DemoDayBanner|fonts\.googleapis/);
    expect(out.message.length).toBeLessThan(200);
  });

  it('passes a real API message through untouched — masking those would hide the cause', () => {
    const err = new Error("Insufficient permissions — READ access denied for 'asset'");
    expect(humanError(err, 'list-assets')).toBe(err);
  });

  it('handles a thrown non-Error without inventing an HTML verdict', () => {
    const out = humanError('socket hang up', 'list-sites');
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('socket hang up');
  });
});

/*
 * The gateway detector decides whether a fallback is legitimate.
 *
 * Measured 2026-08-16 against org #2915: execute-button-for-a-record answers
 * every button with the web client's index.html — the documented {id} lookup
 * shape, a bare value, and a systemButton carrying no formData at all all fail
 * identically. So the app finishes state transitions through
 * change-work-order-status instead. That fallback must fire ONLY when the
 * server never answered; a refusal it actually authored has to reach the user,
 * or the app would move a record the workflow just declined to move.
 */
describe('isGatewayFailure', () => {
  it('recognises the humanised sentence execute() has already written', () => {
    expect(isGatewayFailure(humanError(new Error(GATEWAY_PAGE), 'execute-button-for-a-record'))).toBe(
      true,
    );
  });

  it('recognises a raw HTML page, for anything that skips humanError', () => {
    expect(isGatewayFailure(new Error(GATEWAY_PAGE))).toBe(true);
  });

  it('does NOT claim a refusal the server actually authored', () => {
    expect(isGatewayFailure(new Error('Insufficient permissions — READ access denied'))).toBe(false);
    expect(isGatewayFailure(new Error('Transition criteria not met'))).toBe(false);
    expect(isGatewayFailure(new Error('module is not accessible in this app'))).toBe(false);
    expect(isGatewayFailure(undefined)).toBe(false);
  });
});
