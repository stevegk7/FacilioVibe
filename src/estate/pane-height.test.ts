// A mechanical guard for the rule "a screen fills its pane, not the viewport".
//
// jsdom does no layout, so the geometry itself cannot be asserted here — the real
// measurement was taken in a browser at 375x812, where `.estate-3d` came out
// 812px inside a 714px parent and clipped the detail card's footer actions and
// the walk-in pad's bottom row below the fold. Any top banner (demo or error)
// made it worse, and the Facilio iframe host clipped it too.
//
// This test therefore guards the CAUSE rather than the symptom: a viewport-height
// token must not be used for the height of a screen that renders inside the
// shell's already-inset main pane. It is the same trick as provider-seam.test.ts
// — turn a rule someone has to remember into one the suite enforces.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Read a rule's declaration block from a stylesheet, comments stripped. */
function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const start = withoutComments.indexOf(selector + ' {');
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = withoutComments.indexOf('{', start);
  const close = withoutComments.indexOf('}', open);
  return withoutComments.slice(open + 1, close);
}

// __dirname, not import.meta.url — the jsdom environment does not give this
// module a file: URL, which provider-seam.test.ts already worked around the same way.
const ESTATE_CSS = readFileSync(join(__dirname, 'estate.css'), 'utf8');

describe('screens fill their pane, not the viewport', () => {
  it('.estate-3d does not take its height from a full-viewport measurement', () => {
    const body = ruleBody(ESTATE_CSS, '.estate-3d');
    const height = /(?:^|\s)height:\s*([^;]+);/.exec(body)?.[1]?.trim();

    expect(height).toBeDefined();
    // --app-h, 100vh and 100dvh are all "the whole visible viewport". This screen
    // is a child of .as-mobile-main, which the dock and any banner have already
    // shortened, so all three over-size it by exactly the chrome above and below.
    expect(height).not.toMatch(/--app-h|100vh|100dvh/);
    expect(height).toBe('100%');
  });

  it('keeps min-height: 0 so the flex column can actually shrink', () => {
    const body = ruleBody(ESTATE_CSS, '.estate-3d');
    expect(body).toMatch(/min-height:\s*0/);
  });
});
