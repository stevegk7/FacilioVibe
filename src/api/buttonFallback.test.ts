/**
 * The real provider's button runner, and what it does when the platform's own
 * runner will not answer.
 *
 * Measured against org #2915 (2026-08-16): execute-button-for-a-record returns
 * the Facilio web client's index.html for EVERY button — the documented {id}
 * lookup shape, a bare value, and a systemButton carrying no formData at all,
 * all identically. Two transitions were then completed by hand through
 * change-work-order-status (Yet to Start -> Assigned, Assigned -> Work in
 * Progress), which is the path these tests pin.
 *
 * The rule that matters is the NEGATIVE one: a refusal the server actually
 * authored must never be worked around, or the app would move a record the
 * workflow had just declined to move.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const GATEWAY_HTML =
  'executeAction facilio-record-level-button-actions/execute-button-for-a-record failed: 502 — ' +
  '<!doctype html>\n<html lang="en"><head><title>Facilio</title></head></html>';

/** Every executeAction the provider makes, in order, so we can assert the path. */
const calls: Array<{ connection: string; action: string; payload: Record<string, unknown> }> = [];
/** What the button runner should throw for a given test. */
let runnerError: Error | null = null;

vi.mock('./vibe', () => ({
  vibe: {
    executeAction: vi.fn(async (connection: string, action: string, payload: Record<string, unknown>) => {
      calls.push({ connection, action, payload });
      if (action === 'execute-button-for-a-record') {
        if (runnerError) throw runnerError;
        return { success: true };
      }
      if (action === 'list-states') {
        return {
          items: [
            { id: 183230, status: 'Assigned', displayName: 'Assigned' },
            { id: 183231, status: 'Work in Progress', displayName: 'Work in Progress' },
          ],
        };
      }
      if (action === 'change-work-order-status') return { data: { id: 14275669 } };
      return {};
    }),
  },
}));

let realProvider: typeof import('./realProvider').realProvider;

const ran = (action: string) => calls.filter((c) => c.action === action);

describe('a work-order button when the platform runner is down', () => {
  beforeEach(async () => {
    vi.resetModules();
    calls.length = 0;
    runnerError = null;
    ({ realProvider } = await import('./realProvider'));
  });

  it('uses the platform runner when it answers, and does NOT fall back', async () => {
    await realProvider.executeWorkOrderAction(14275669, {
      buttonId: 3354892,
      buttonType: 'stateTransition',
      toStateId: 183231,
    });
    expect(ran('execute-button-for-a-record')).toHaveLength(1);
    // The real runner also fires the transition's workflow actions, so when it
    // works it must be the ONLY thing that runs.
    expect(ran('change-work-order-status')).toHaveLength(0);
  });

  it('completes the transition through the status catalogue when the runner returns a page', async () => {
    runnerError = new Error(GATEWAY_HTML);
    await realProvider.executeWorkOrderAction(14275669, {
      buttonId: 3354892,
      buttonType: 'stateTransition',
      toStateId: 183231,
    });
    // Tried first, every time — the day the platform recovers, no change here.
    expect(ran('execute-button-for-a-record')).toHaveLength(1);
    // toStateId 183231 resolved through list-states to its status NAME.
    const change = ran('change-work-order-status')[0];
    expect(change).toBeDefined();
    expect(change.payload).toMatchObject({ id: 14275669, status: 'Work in Progress' });
  });

  it('refuses to work around a refusal the server actually authored', async () => {
    runnerError = new Error('Insufficient permissions — READ access denied for this transition');
    await expect(
      realProvider.executeWorkOrderAction(14275669, {
        buttonId: 3354892,
        buttonType: 'stateTransition',
        toStateId: 183231,
      }),
    ).rejects.toThrow(/Insufficient permissions/);
    expect(ran('change-work-order-status')).toHaveLength(0);
  });

  it('does not invent a destination for a button that names none', async () => {
    // A systemButton (Print) has no toStateId. There is nothing to fall back
    // TO, so the gateway failure must surface rather than be swallowed.
    runnerError = new Error(GATEWAY_HTML);
    await expect(
      realProvider.executeWorkOrderAction(14275669, {
        buttonId: 3344466,
        buttonType: 'systemButton',
      }),
    ).rejects.toThrow();
    expect(ran('change-work-order-status')).toHaveLength(0);
  });
});
