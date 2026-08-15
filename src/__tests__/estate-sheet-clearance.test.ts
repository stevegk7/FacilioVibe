// The camera rail has to clear whatever is docked at the bottom.
//
// On a phone BOTH the detail card and the browse panel dock full-width at the
// bottom, and the zoom/back/reset rail centres itself in the band they leave
// free — `--est-sheet-h`, published from the sheet's measured box. Only the card
// ever published it. With the panel open the variable was absent, the rail
// centred on the whole stage, and its bottom button landed ON the panel's
// Collapse: measured at 375x812, "Reset view" (328-366 x 435-471) overlapped
// Collapse (320-344 x 452-476) by 16x19px, and since the panel paints at
// z-index 24 over the rail's 22, the tap collapsed the panel instead of
// resetting the camera.
//
// jsdom has no layout, so this cannot be caught by rendering — and EstateScreen
// needs the 3D engine, which is why no test renders it. The contract is
// asserted where it lives: the source. Same approach as
// keyboard-viewport.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const screen = readFileSync('src/screens/EstateScreen.tsx', 'utf8');
const css = readFileSync('src/estate/estate.css', 'utf8');

describe('docked sheets reserve the band the camera rail sits in', () => {
  it('BOTH bottom-docked sheets publish their coverage', () => {
    // The card was always wired; the panel is the one that was missing.
    expect(screen).toMatch(/ref=\{cardRef\}/);
    expect(screen).toMatch(/ref=\{panelRef\}/);
    // …and the panel ref belongs to the element that is actually drawn, so the
    // measurement reflects the white box rather than its transparent wrapper.
    expect(screen).toMatch(/className="est-panel-in"\s*\n\s*ref=\{panelRef\}/);
  });

  it('publishes the LARGER coverage, not whichever sheet reported last', () => {
    const effect = screen.slice(screen.indexOf('const write = () => {'));
    expect(effect).toMatch(/for \(const el of \[cardElRef\.current, panelElRef\.current\]\)/);
    expect(effect).toMatch(/covered = Math\.max\(/);
    expect(effect).toMatch(/setProperty\('--est-sheet-h'/);
  });

  it('measures outside the ref callback, which runs before the stage exists', () => {
    /* The regression that hid this for so long: React attaches child refs
       before parent ones, so a panel measuring inside its own ref callback
       found stageRef.current null and silently published nothing. */
    const refDecl = screen.slice(
      screen.indexOf('const panelRef = useCallback'),
      screen.indexOf('useEffect', screen.indexOf('const panelRef = useCallback')),
    );
    expect(refDecl).not.toMatch(/getBoundingClientRect|--est-sheet-h/);
    expect(refDecl).toMatch(/setSheetTick/);
  });

  it('the phone rule still consumes the variable', () => {
    const phone = css.slice(css.indexOf('.est-panel {'));
    expect(phone).toMatch(/--est-sheet-h/);
    expect(css).toMatch(/top: calc\(\(100% - var\(--est-sheet-h, 0px\)\) \/ 2\)/);
  });

  it('expands panel tap targets by hit area only, and not the stacked zoom rail', () => {
    // A pseudo-element takes no part in layout, so the dense header keeps its
    // drawn size. Scope matters: .est-tool is also the rail's class, where the
    // buttons are 36px apart and a 44px target WOULD overlap its neighbour.
    expect(css).toMatch(/\.est-panel-in \.est-tool::after/);
    expect(css).toMatch(/\.est-panel-in \.est-crumb::after/);
    const rule = css.slice(css.indexOf('.est-panel-in .est-tool,'));
    expect(rule.slice(0, rule.indexOf('/* ---------- hover'))).not.toMatch(
      /^\s*\.est-tool::after/m,
    );
  });
});
