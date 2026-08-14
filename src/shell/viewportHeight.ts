/**
 * Keeps --app-h equal to what is ACTUALLY visible — and owns the keyboard.
 *
 * 100dvh fixed the iPhone case, but on iPad the desktop shell still came up
 * short and left a dead band under the app. The visual viewport is the only
 * source that is right on every platform, so measure it and let CSS keep
 * 100dvh purely as the pre-JS fallback.
 *
 * KEYBOARD: when the on-screen keyboard opens, the visual viewport shrinks
 * but the LAYOUT viewport does not — so anything anchored `bottom: 0` with
 * position:fixed stays under the keyboard (hidden buttons), while the
 * flex-laid dock rode up on top of it (the "icons go up" report). Three
 * things fix all of it at once:
 *   - `kb-open` on <html> while a keyboard is up → CSS hides the dock and
 *     lets full-screen surfaces use the whole visible area
 *   - every full-screen surface is sized by --app-h (never `bottom: 0`), so
 *     shrinking --app-h moves footers ABOVE the keyboard
 *   - --vv-top mirrors visualViewport.offsetTop, so if iOS pans the page to
 *     reveal a focused input, the app is translated back under the finger
 */
export function installViewportHeight(): void {
  /** Anything smaller than this is browser chrome settling, not a keyboard. */
  const KEYBOARD_MIN_PX = 120;

  // A fixed inset-0 probe: its offsetHeight IS the initial containing block,
  // whatever innerHeight/visualViewport claim — the same guarantee the fixed
  // #root relies on, exposed as a number for the surfaces that need one.
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;inset:0;visibility:hidden;pointer-events:none;z-index:-1;';
  (document.body ?? document.documentElement).appendChild(probe);

  const apply = () => {
    const vv = window.visualViewport;
    const vvH = vv?.height ?? window.innerHeight;
    // A height gap only means "keyboard" while something editable is focused.
    // Without that, a smaller visual viewport is STALE data — iOS collapses
    // the Safari toolbar without firing resize for fixed layouts, which left
    // the dock floating above a dead band. Trust the larger measurement then.
    const editing = !!document.activeElement?.matches?.('input, textarea, [contenteditable]');
    const keyboard = editing && window.innerHeight - vvH > KEYBOARD_MIN_PX;
    const h = keyboard ? vvH : Math.max(vvH, window.innerHeight, probe.offsetHeight);
    // JS writes the MEASUREMENT; CSS derives --app-h as max(100dvh, this).
    // The engine's dvh is definitionally right across browser-chrome states
    // (including in-app webviews whose collapsing bars misreport through
    // BOTH JS APIs); the measurement exists to raise the floor where dvh
    // itself comes up short (the iPad shell), and to carry the keyboard
    // height, where the smaller value must win (html.kb-open flips to it).
    if (h > 0) document.documentElement.style.setProperty('--app-h-px', `${Math.round(h)}px`);
    document.documentElement.style.setProperty('--vv-top', `${Math.round(vv?.offsetTop ?? 0)}px`);
    document.documentElement.classList.toggle('kb-open', keyboard);
  };

  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
  window.visualViewport?.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('scroll', apply);
  // iOS fires focus before the keyboard finishes animating — settle late.
  window.addEventListener('focusin', () => setTimeout(apply, 250));
  window.addEventListener('focusout', () => setTimeout(apply, 250));
  // Safari settles its chrome after load; re-measure once it has.
  window.addEventListener('load', () => setTimeout(apply, 120));
  // The belt-and-braces heal: iOS toolbar collapse can fire NO event at all.
  // One cheap style write per second keeps the frame honest forever.
  setInterval(apply, 1000);
}
